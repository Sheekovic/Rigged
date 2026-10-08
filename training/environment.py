"""Historical strategy environment. Actions occur at known candle closes."""
import math
import numpy as np

CONFIG={'version':3,'leverage':120,'allocation':.1,'target_roi':2,'stop_roi':-1,
        'entry_tolerance':.001,'fee_rate':.0005,'slippage':.0001,'maintenance_rate':.004,
        'minimum_notional':100,'cooldown_minutes':5,'max_daily_entries':6,'fib_stop_buffer':.001}
ACTIONS=['wait','enter_tight_stop','enter_standard_stop','enter_wide_stop','close_position']
STOP_BUFFERS={1:.0005,2:.001,3:.002}

class Market:
    def __init__(self,data,config=None):
        self.data=np.asarray(data);self.config={**CONFIG,**(config or {})}
        if self.data.ndim!=2 or self.data.shape[1]!=11:raise ValueError('Expected 11 dataset columns')
        if not len(data) or not np.all(np.diff(data[:,0])==60000):raise ValueError('Continuous minute history required')
        if data[0,0]%86400000 or len(data)%1440:raise ValueError('Complete UTC days required')
        n=len(data);p=data[:,4];self.day=(data[:,0]//86400000).astype(np.int64)
        self.range_low=np.zeros(n);self.range_high=np.zeros(n);self.fib_low=np.zeros(n);self.fib_high=np.zeros(n);self.direction=np.zeros(n)
        for start in range(0,n,1440):
            rows=data[start:start+1440];low=np.minimum.accumulate(rows[:,3]);high=np.maximum.accumulate(rows[:,2]);fixed=np.minimum(np.arange(1440),719)
            self.range_low[start:start+1440]=low[fixed];self.range_high[start:start+1440]=high[fixed]
            hourly_high=rows[:,2].reshape(24,60).max(axis=1);hourly_low=rows[:,3].reshape(24,60).min(axis=1)
            # A bar ending :59 makes that completed hourly candle available at its close.
            complete=(np.arange(1440)+1)//60
            for count in range(2,25):
                li=int(np.argmin(hourly_low[:count]));hi=int(np.argmax(hourly_high[:count]));mask=complete==count
                if li!=hi and hourly_high[hi]>hourly_low[li]:
                    self.fib_low[start:start+1440][mask]=hourly_low[li]
                    self.fib_high[start:start+1440][mask]=hourly_high[hi]
                    self.direction[start:start+1440][mask]=1 if li<hi else -1
        fib_span=np.maximum(self.fib_high-self.fib_low,1e-8)
        retracement=np.where(self.direction>0,(self.fib_high-p)/fib_span,(p-self.fib_low)/fib_span)
        near_low=(p>=self.range_low)&(p<=self.range_low*(1+self.config['entry_tolerance']))
        near_high=(p<=self.range_high)&(p>=self.range_high*(1-self.config['entry_tolerance']))
        sign=np.where(near_low,1,-1);entry=p*(1+sign*self.config['slippage'])
        slipped_retrace=np.where(self.direction>0,(self.fib_high-entry)/fib_span,(entry-self.fib_low)/fib_span)
        minute=(data[:,0]%86400000/60000).astype(int)
        self.eligible=(minute>=720)&(minute<1439)&(near_low!=near_high)&(self.direction==sign)&(slipped_retrace>=.618)&(slipped_retrace<=1)
        self.candidates=np.flatnonzero(self.eligible)
        returns=[]
        for lag in (1,5,15,60):
            prior=np.concatenate([np.repeat(p[0],lag),p[:-lag]]) if n>=lag else np.repeat(p[0],n)
            returns.append(np.log(p/prior)*100)
        logret=returns[0]/100
        count=np.minimum(np.arange(n)+1,30)
        mean=np.convolve(logret,np.ones(30),mode='full')[:n]/count
        var=np.convolve(logret**2,np.ones(30),mode='full')[:n]/count-mean**2
        vol=np.sqrt(np.maximum(0,var))*100
        volume_mean=np.convolve(data[:,5],np.ones(60),mode='full')[:n]/np.minimum(np.arange(n)+1,60)
        range_span=np.maximum(self.range_high-self.range_low,1e-8)
        features=[*returns,vol,(p-self.range_low)/range_span,
                  np.log(p/self.range_low)*100,np.log(p/self.range_high)*100,self.direction,
                  np.where(self.direction!=0,retracement,0),
                  np.where(self.direction!=0,(p-self.fib_low)/p*100,0),
                  np.where(self.direction!=0,(self.fib_high-p)/p*100,0),
                  np.sin(minute/1440*2*np.pi),np.cos(minute/1440*2*np.pi),
                  np.log1p(data[:,5]/np.maximum(volume_mean,1e-8)),
                  (data[:,9]/p-1)*1000,(p/data[:,1]-1)*100,(data[:,2]-data[:,3])/p*100]
        self.features=np.clip(np.column_stack(features),-10,10).astype(np.float32)
        if not np.all(np.isfinite(self.features)):raise ValueError('Non-finite model features')

class TradingEnv:
    observation_size=27
    def __init__(self,market):self.market=market;self.c=market.config
    def reset(self,start,end):
        if start<0 or end>len(self.market.data) or start>=end:raise ValueError('Invalid episode bounds')
        self.start=start;self.end=end;self.i=start;self.balance=100.;self.equity=100.;self.peak=100.;self.drawdown=0.;self.position=None
        self.entry_day=None;self.entries_today=0;self.cooldown_until=0;self.trades=[];self.done=False
        self._seek_flat(start)
        return self.observation()
    def _sync_day(self):
        day=int(self.market.day[self.i])
        if day!=self.entry_day:self.entry_day=day;self.entries_today=0
    def _seek_flat(self,minimum):
        candidates=self.market.candidates;offset=int(np.searchsorted(candidates,minimum))
        for idx in candidates[offset:]:
            if idx>=self.end:break
            self.i=int(idx);self._sync_day()
            if self.market.data[idx,0]+60000>=self.cooldown_until and self.entries_today<self.c['max_daily_entries']:
                if self.balance*self.c['allocation']*self.c['leverage']<self.c['minimum_notional']:break
                return
        self.i=self.end-1;self.done=True
    def action_mask(self):
        enter=not self.done and self.position is None and self.market.eligible[self.i] and self.entries_today<self.c['max_daily_entries']
        return np.array([True,enter,enter,enter,not self.done and self.position is not None],dtype=bool)
    def observation(self):
        p=self.position;row=self.market.data[self.i];side=p['sign'] if p else 0
        dynamic=[math.log(max(self.equity,.01)/100),self.balance/max(self.equity,.01)-1,
                 side*p['qty']*(row[9]-p['entry'])/p['margin'] if p else 0,side,self.entries_today/6,
                 math.log1p(self.i-p['index'])/10 if p else 0,
                 (row[4]-p['stop'])/row[4]*100 if p else 0,(p['target']-row[4])/row[4]*100 if p else 0,self.drawdown]
        return np.clip(np.concatenate([self.market.features[self.i],dynamic]),-10,10).astype(np.float32)
    def _enter(self,action):
        m=self.market;row=m.data[self.i];sign=int(m.direction[self.i]);margin=self.balance*self.c['allocation'];entry=row[4]*(1+sign*self.c['slippage'])
        low=m.fib_low[self.i];high=m.fib_high[self.i];span=high-low
        recovery=high-span*.382 if sign>0 else low+span*.382
        invalidation=low*(1-STOP_BUFFERS[action]) if sign>0 else high*(1+STOP_BUFFERS[action])
        roi_target=entry*(1+sign*self.c['target_roi']/self.c['leverage']);roi_stop=entry*(1+sign*self.c['stop_roi']/self.c['leverage'])
        target=min(recovery,roi_target) if sign>0 else max(recovery,roi_target);stop=max(invalidation,roi_stop) if sign>0 else min(invalidation,roi_stop)
        if not (stop<entry<target if sign>0 else target<entry<stop):raise ValueError('Invalid entry plan')
        qty=margin*self.c['leverage']/entry;fee=margin*self.c['leverage']*self.c['fee_rate'];self.balance-=fee
        self.position={'sign':sign,'side':'long' if sign>0 else 'short','entry':entry,'qty':qty,'margin':margin,'entry_fee':fee,'funding':0.,'index':self.i,
                       'opened_at':int(row[0]+60000),'stop':stop,'target':target,'buffer':STOP_BUFFERS[action],
                       'stop_reason':'stop loss' if stop==roi_stop else 'Fibonacci invalidation',
                       'target_reason':'take profit' if target==roi_target else 'Fibonacci recovery'}
        self.entries_today+=1
    def _close(self,price,reason,liquidation=False):
        p=self.position;exit_price=price*(1-p['sign']*self.c['slippage']);fee=p['qty']*exit_price*self.c['fee_rate'];before=self.balance
        self.balance=0. if liquidation else max(0.,self.balance+p['sign']*p['qty']*(exit_price-p['entry'])-fee)
        self.trades.append({'side':p['side'],'entry':p['entry'],'exit':exit_price,'margin':p['margin'],
                            'opened_at':p['opened_at'],'closed_at':int(self.market.data[self.i,0]+60000),
                            'net_pnl':self.balance-before-p['entry_fee']-p['funding'],'fees':p['entry_fee']+fee,'funding':p['funding'],'reason':reason,'stop_buffer':p['buffer']})
        self.cooldown_until=int(self.market.data[self.i,0]+60000+self.c['cooldown_minutes']*60000);self.position=None
    def _risk(self):
        p=self.position;r=self.market.data[self.i];sign=p['sign']
        cost=p['qty']*r[6]*r[10]*sign;self.balance-=cost;p['funding']+=cost
        worst=r[8] if sign>0 else r[7]
        if self.balance+sign*p['qty']*(worst-p['entry'])<=p['qty']*worst*self.c['maintenance_rate']:
            self._close(worst,'cross liquidation (approx.)',True)
        elif (r[3]<=p['stop'] if sign>0 else r[2]>=p['stop']):
            self._close(min(r[1],p['stop']) if sign>0 else max(r[1],p['stop']),p['stop_reason'])
        elif (r[2]>=p['target'] if sign>0 else r[3]<=p['target']):
            self._close(max(r[1],p['target']) if sign>0 else min(r[1],p['target']),p['target_reason'])
    def step(self,action):
        if self.done:raise ValueError('Reset a completed episode before stepping')
        if not self.action_mask()[action]:raise ValueError('Action violates a hard strategy constraint')
        before=self.equity;previous_drawdown=self.drawdown
        if action in STOP_BUFFERS:self._enter(action)
        elif action==4:self._close(self.market.data[self.i,4],'policy exit')
        # Record the entry fee and immediate mark-price spread before moving forward.
        p=self.position
        action_equity=max(0.,self.balance+(p['sign']*p['qty']*(self.market.data[self.i,9]-p['entry']) if p else 0))
        self.peak=max(self.peak,action_equity);self.drawdown=max(self.drawdown,1-action_equity/self.peak)
        if self.position:
            if self.i+1<self.end:
                self.i+=1;self._sync_day();self._risk()
            else:self.done=True
            if self.position is None:self._seek_flat(self.i+1)
        else:self._seek_flat(self.i+1)
        if self.i==self.end-1:self.done=True
        if self.done and self.position:self._close(self.market.data[self.i,4],'episode end')
        p=self.position
        self.equity=max(0.,self.balance+(p['sign']*p['qty']*(self.market.data[self.i,9]-p['entry']) if p else 0))
        self.peak=max(self.peak,self.equity);self.drawdown=max(self.drawdown,1-self.equity/self.peak)
        if self.equity<=0:self.done=True
        reward=math.log(max(self.equity,.01)/max(before,.01))-.2*(self.drawdown-previous_drawdown)
        return self.observation(),reward,self.done
    def result(self):
        return {'start':int(self.market.data[self.start,0]),'end':int(self.market.data[self.end-1,0]+60000),
                'equity':self.equity,'return_pct':self.equity-100,'max_drawdown_pct':self.drawdown*100,
                'trades':len(self.trades),'wins':int(sum(t['net_pnl']>0 for t in self.trades)),
                'fees':sum(t['fees'] for t in self.trades),'funding':sum(t['funding'] for t in self.trades)}
