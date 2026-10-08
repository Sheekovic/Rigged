import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch
import numpy as np
import torch
from .environment import Market,TradingEnv
from .train import Policy,optimize,final_evaluations

def fixture(short=False):
    rows=[];start=1704067200000
    for i in range(2880):
        minute=i%1440
        if minute<60:o=h=l=c=100.
        elif minute<120:o=h=l=c=110.
        elif minute<720:o=c=105.;h=106.;l=104.
        elif minute<780:
            # Repeated valid range-edge setups, followed by profitable recovery.
            o=c=100.05 if minute%10==0 else 103.;h=c+.01;l=c-.01
        else:o=c=105.;h=106.;l=104.
        if short:o,h,l,c=210-o,210-l,210-h,210-c
        rate=.0001 if minute==721 else 0.
        rows.append([start+i*60000,o,h,l,c,10.,o,h,l,c,rate])
    return np.asarray(rows)

class TrainingTests(unittest.TestCase):
    def test_validation_only_never_evaluates_test_dates(self):
        validation=[(1,2)];test=[(3,4)]
        with patch('training.train.evaluate',return_value={'summary':{}}) as evaluation:
            result=final_evaluations(None,None,validation,test,validation_only=True)
            evaluation.assert_called_once_with(None,None,validation)
        self.assertIsNone(result['test_policy']);self.assertIsNone(result['test_fixed_strategy'])
    def test_matches_deployed_long_and_short(self):
        for short in (False,True):
            data=fixture(short);env=TradingEnv(Market(data));env.reset(0,len(data))
            while not env.done:env.step(2 if env.action_mask()[2] else 0)
            reference=Path(__file__).with_name('reference.mjs')
            result=subprocess.run(['node',str(reference)],input=json.dumps(data.tolist()),text=True,capture_output=True,check=True)
            expected=json.loads(result.stdout)
            self.assertEqual(len(env.trades),12);self.assertEqual(len(env.trades),len(expected['trades']))
            self.assertAlmostEqual(env.balance,expected['balance'],places=9)
            json.dumps(env.result())
            for actual,target in zip(env.trades,expected['trades']):
                for key in ('entry','exit','margin','net_pnl','fees','funding'):self.assertAlmostEqual(actual[key],target[key],places=9)
                self.assertEqual(actual['reason'],target['reason'])
    def test_no_future_leak(self):
        data=fixture();modified=data.copy();modified[900:,1:10]*=2
        first=Market(data);second=Market(modified)
        np.testing.assert_array_equal(first.features[:900],second.features[:900])
        np.testing.assert_array_equal(first.eligible[:900],second.eligible[:900])
    def test_hard_constraints_and_reset(self):
        env=TradingEnv(Market(fixture()));env.reset(0,2880);env.step(2)
        self.assertEqual(env.c['leverage'],120)
        # Recovery closes the first trade; later setups respect the daily cap.
        while not env.done:env.step(2 if env.action_mask()[2] else 0)
        dates={}
        for t in env.trades:dates[t['opened_at']//86400000]=dates.get(t['opened_at']//86400000,0)+1
        self.assertLessEqual(max(dates.values()),6)
        self.assertTrue(all(a['closed_at']<=b['opened_at'] for a,b in zip(env.trades,env.trades[1:])))
        env.reset(1440,2880);self.assertEqual(env.equity,100);self.assertEqual(env.balance,100)
        # A setup with a held position cannot enter a second position.
        slow=fixture();slow[721:725,1:5]=[100.1,100.11,100.09,100.1];slow[721:725,6:10]=slow[721:725,1:5]
        held=TradingEnv(Market(slow));held.reset(0,2880);held.step(2)
        self.assertIsNotNone(held.position)
        with self.assertRaises(ValueError):held.step(2)
    def test_conservative_stop_and_liquidation(self):
        data=fixture();data[721,1:5]=[100.05,110.,99.,100.05];data[721,6:10]=data[721,1:5]
        env=TradingEnv(Market(data));env.reset(0,2880);env.step(2)
        self.assertEqual(env.trades[0]['reason'],'Fibonacci invalidation')
        data[721,8]=80.
        env=TradingEnv(Market(data));env.reset(0,2880);env.step(2)
        self.assertEqual(env.trades[0]['reason'],'cross liquidation (approx.)');self.assertEqual(env.equity,0)
    def test_optimizer_updates_actual_weights(self):
        torch.manual_seed(42);torch.set_num_threads(2);policy=Policy();optimizer=torch.optim.Adam(policy.parameters(),lr=3e-4)
        obs=torch.randn(64,27);masks=torch.ones(64,5,dtype=torch.bool);masks[:,3]=False
        with torch.no_grad():dist,value=policy(obs,masks);actions=dist.sample();old=dist.log_prob(actions)
        self.assertFalse(bool((actions==3).any()));before=policy.actor.weight.detach().clone()
        loss=optimize(policy,optimizer,obs,masks,actions,old,torch.randn(64),torch.randn(64),epochs=2)
        self.assertTrue(np.isfinite(loss));self.assertFalse(torch.equal(before,policy.actor.weight))
    def test_refuses_missing_candles(self):
        with self.assertRaises(ValueError):Market(np.delete(fixture(),100,axis=0))
    @unittest.skipUnless(Path(__file__).with_name('data').joinpath('btc-usdt-1m.npy').exists(),'Local historical dataset not downloaded')
    def test_historical_fixed_strategy_matches_deployed_engine(self):
        dataset=np.load(Path(__file__).with_name('data')/'btc-usdt-1m.npy',mmap_mode='r')
        # One held-out week verifies historical fill parity; it does not tune the policy.
        start=int(np.searchsorted(dataset[:,0],1759276800000));data=np.array(dataset[start:start+7*1440])
        env=TradingEnv(Market(data));env.reset(0,len(data))
        while not env.done:env.step(2 if env.action_mask()[2] else 0)
        result=subprocess.run(['node',str(Path(__file__).with_name('reference.mjs'))],input=json.dumps(data.tolist()),text=True,capture_output=True,check=True)
        expected=json.loads(result.stdout)
        self.assertIsNone(expected['position'],'Pick a closed-position week for fill parity')
        self.assertEqual(len(env.trades),len(expected['trades']))
        self.assertGreater(len(env.trades),0)
        self.assertAlmostEqual(env.balance,expected['balance'],places=8)
        for actual,target in zip(env.trades,expected['trades']):
            for key in ('entry','exit','net_pnl','fees','funding'):self.assertAlmostEqual(actual[key],target[key],places=8)

if __name__=='__main__':unittest.main()
