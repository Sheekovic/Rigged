"""Small masked PPO policy, trained locally; never sends exchange orders."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import random
import time
import numpy as np
import torch
from torch import nn
from torch.distributions import Categorical
from .environment import ACTIONS, CONFIG, Market, TradingEnv

ROOT=Path(__file__).resolve().parent
SPLITS={'train':['2024-01-01','2025-07-01'], 'validation':['2025-07-01','2025-10-01'], 'test':['2025-10-01','2026-01-01']}

class Policy(nn.Module):
    def __init__(self):
        super().__init__()
        self.body=nn.Sequential(nn.Linear(27,128),nn.Tanh(),nn.Linear(128,128),nn.Tanh())
        self.actor=nn.Linear(128,len(ACTIONS));self.critic=nn.Linear(128,1)
        for layer in self.modules():
            if isinstance(layer,nn.Linear):nn.init.orthogonal_(layer.weight, np.sqrt(2));nn.init.zeros_(layer.bias)
        nn.init.orthogonal_(self.actor.weight,.01);nn.init.orthogonal_(self.critic.weight,1.)
    def forward(self,observations,masks):
        hidden=self.body(observations)
        return Categorical(logits=self.actor(hidden).masked_fill(~masks,-1e9)),self.critic(hidden).squeeze(-1)

def bounds(market,dates):
    timestamps=[datetime.fromisoformat(d).replace(tzinfo=timezone.utc).timestamp()*1000 for d in dates]
    result=[int(np.searchsorted(market.data[:,0],ts)) for ts in timestamps]
    if result[1]<=result[0]:raise ValueError(f'No data in split {dates}')
    return result

def blocks(start,end,days=7):
    size=days*1440
    return [(i,min(i+size,end)) for i in range(start,end,size)]

def evaluate(policy,market,episodes,baseline=False):
    results=[];policy.eval()
    with torch.no_grad():
        for start,end in episodes:
            env=TradingEnv(market);obs=env.reset(start,end)
            while not env.done:
                mask=env.action_mask()
                if baseline:action=2 if mask[2] else 0
                else:
                    distribution,_=policy(torch.from_numpy(obs[None]),torch.from_numpy(mask[None]))
                    action=int(distribution.logits.argmax(-1).item())
                obs,_,_=env.step(action)
            results.append(env.result())
    policy.train()
    equity=np.array([r['equity'] for r in results]);drawdowns=np.array([r['max_drawdown_pct'] for r in results])
    summary={'episodes':len(results),'median_final_equity':float(np.median(equity)),
             'mean_final_equity':float(equity.mean()),'minimum_final_equity':float(equity.min()),
             'profitable_episodes':int((equity>100).sum()),'liquidated_episodes':int((equity==0).sum()),
             'mean_max_drawdown_pct':float(drawdowns.mean()),'worst_drawdown_pct':float(drawdowns.max()),
             'trades':sum(r['trades'] for r in results),'fees':sum(r['fees'] for r in results),
             'funding':sum(r['funding'] for r in results)}
    # Checkpoint selection uses only validation, with ruin bounded in log space.
    score=float(np.log(np.maximum(equity,.01)/100).mean()-.2*drawdowns.mean()/100)
    return {'summary':summary,'episodes':results,'selection_score':score}

def optimize(policy,optimizer,obs,masks,actions,old_logprobs,returns,advantages,epochs=4):
    advantages=(advantages-advantages.mean())/(advantages.std(unbiased=False)+1e-8)
    losses=[]
    for _ in range(epochs):
        for indices in torch.randperm(len(obs)).split(256):
            distribution,value=policy(obs[indices],masks[indices]);ratio=(distribution.log_prob(actions[indices])-old_logprobs[indices]).exp()
            actor=-torch.minimum(ratio*advantages[indices],ratio.clamp(.8,1.2)*advantages[indices]).mean()
            critic=(value-returns[indices]).square().mean()
            loss=actor+.5*critic-.01*distribution.entropy().mean()
            if not torch.isfinite(loss):raise ValueError('Non-finite training loss')
            optimizer.zero_grad();loss.backward();nn.utils.clip_grad_norm_(policy.parameters(),.5);optimizer.step()
            losses.append(float(loss.detach()))
    return float(np.mean(losses))

def train(market,output,updates=40,rollout=1024,seed=42,resume=None):
    random.seed(seed);np.random.seed(seed);torch.manual_seed(seed);torch.set_num_threads(4)
    output.mkdir(parents=True,exist_ok=True)
    dataset_hash=hashlib.sha256((ROOT/'data'/'btc-usdt-1m.npy').read_bytes()).hexdigest()
    policy=Policy();optimizer=torch.optim.Adam(policy.parameters(),lr=3e-4)
    completed=0
    if resume:
        checkpoint=torch.load(resume,map_location='cpu',weights_only=True)
        if checkpoint['dataset_sha256']!=dataset_hash or checkpoint['splits']!=SPLITS or checkpoint['config']!=CONFIG:
            raise ValueError('Resume requires the same verified dataset, splits, and strategy')
        if checkpoint['rollout']!=rollout:raise ValueError('Resume requires the original rollout size')
        policy.load_state_dict(checkpoint['policy']);optimizer.load_state_dict(checkpoint['optimizer']);completed=checkpoint['updates']
        torch.set_rng_state(checkpoint['torch_rng']);random.setstate(checkpoint['python_rng'])
    train_start,train_end=bounds(market,SPLITS['train']);validation=blocks(*bounds(market,SPLITS['validation']));test=blocks(*bounds(market,SPLITS['test']))
    def new_episode():
        start=train_start+random.randrange((train_end-train_start)//1440-6)*1440
        return env.reset(start,start+7*1440)
    env=TradingEnv(market);observation=new_episode();best_score=-float('inf');started=time.monotonic()
    def save(path,update):
        torch.save({'policy':policy.state_dict(),'optimizer':optimizer.state_dict(),'updates':update,
                    'decisions':update*rollout,'rollout':rollout,'config':CONFIG,'splits':SPLITS,'dataset_sha256':dataset_hash,
                    'torch_rng':torch.get_rng_state(),'python_rng':random.getstate()},path)
    if resume:
        best_score=evaluate(policy,market,validation)['selection_score'];save(output/'best.pt',completed)
    metrics=output/'metrics.jsonl'
    for update in range(completed+1,completed+updates+1):
        observations=[];masks=[];actions=[];logprobs=[];values=[];rewards=[];terminals=[];episode_results=[]
        for _ in range(rollout):
            while env.done:observation=new_episode()
            mask=env.action_mask()
            with torch.no_grad():
                distribution,value=policy(torch.from_numpy(observation[None]),torch.from_numpy(mask[None]));action=distribution.sample()
            observations.append(observation);masks.append(mask);actions.append(int(action));logprobs.append(float(distribution.log_prob(action)));values.append(float(value))
            observation,reward,done=env.step(int(action));rewards.append(reward);terminals.append(done)
            if done:episode_results.append(env.result())
        with torch.no_grad():
            next_value=0. if env.done else float(policy(torch.from_numpy(observation[None]),torch.from_numpy(env.action_mask()[None]))[1])
        advantages=np.zeros(rollout,np.float32);gae=0.
        for i in reversed(range(rollout)):
            continuation=0. if terminals[i] else 1.
            delta=rewards[i]+continuation*next_value-values[i]
            gae=delta+.95*continuation*gae;advantages[i]=gae;next_value=values[i]
        returns=advantages+np.asarray(values,np.float32)
        loss=optimize(policy,optimizer,torch.from_numpy(np.asarray(observations)),torch.from_numpy(np.asarray(masks)),
                      torch.tensor(actions),torch.tensor(logprobs),torch.from_numpy(returns),torch.from_numpy(advantages))
        record={'update':update,'decisions':update*rollout,'loss':loss,'finished_episodes':len(episode_results),
                'mean_episode_equity':float(np.mean([r['equity'] for r in episode_results])) if episode_results else None,
                'elapsed_seconds':round(time.monotonic()-started,1)}
        if (update-completed)%5==0 or update==completed+updates:
            validation_result=evaluate(policy,market,validation);record['validation']=validation_result['summary']
            if validation_result['selection_score']>best_score:
                best_score=validation_result['selection_score'];save(output/'best.pt',update)
        save(output/'latest.pt',update)
        with metrics.open('a',encoding='utf-8') as stream:stream.write(json.dumps(record)+'\n')
        print(json.dumps(record),flush=True)
    selected=torch.load(output/'best.pt',map_location='cpu',weights_only=True);policy.load_state_dict(selected['policy'])
    report={'method':'masked PPO neural policy','status':'initial experiment, not a proven profitable strategy',
            'dataset_sha256':dataset_hash,'config':CONFIG,'splits':SPLITS,'seed':seed,'selected_update':selected['updates'],
            'completed_updates':completed+updates,'decisions':(completed+updates)*rollout,'wall_seconds':time.monotonic()-started,
            'episode_initial_equity':100,'episode_days':7,'actions':ACTIONS,
            'validation_policy':evaluate(policy,market,validation),
            'test_policy':evaluate(policy,market,test),'test_fixed_strategy':evaluate(policy,market,test,baseline=True),
            'cash_baseline_final_equity':100,
            'limitations':['Approximate cross liquidation, fixed fees and slippage; not exchange-specific historical tiers.',
                           'One-minute OHLC cannot determine intrabar order; adverse fills are resolved first.',
                           'Small initial run; no guarantee of profitability or generalization.',
                           'Test dates must not be reused to tune this experiment. New comparisons require a fresh holdout.']}
    (output/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    (output/'policy.json').write_text(json.dumps({'architecture':[27,128,128,5],'activation':'tanh','actions':ACTIONS,
        'config':CONFIG,'dataset_sha256':dataset_hash,'weights':{k:v.tolist() for k,v in selected['policy'].items()}}),encoding='utf-8')
    print(json.dumps({'report':str(output/'report.json'),'test_policy':report['test_policy']['summary'],
                      'test_fixed_strategy':report['test_fixed_strategy']['summary']}),flush=True)
    return report

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--updates',type=int,default=40);parser.add_argument('--rollout',type=int,default=1024)
    parser.add_argument('--seed',type=int,default=42);parser.add_argument('--resume',type=Path);parser.add_argument('--output',type=Path,default=ROOT/'runs'/'initial')
    args=parser.parse_args()
    if args.updates<1 or args.rollout<32:parser.error('Use at least one update and 32 decisions per rollout')
    if (args.output/'report.json').exists():parser.error('Use a new output directory; preserve prior test results')
    data=np.load(ROOT/'data'/'btc-usdt-1m.npy',mmap_mode='r');market=Market(data)
    train(market,args.output,args.updates,args.rollout,args.seed,args.resume)
if __name__=='__main__':main()
