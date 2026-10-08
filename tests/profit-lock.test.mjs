import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CONFIG,initialState,step,profitLockPrice} from '../supabase/functions/rigged-tick/engine.mjs';
const t=Date.parse('2026-10-08T12:00:00Z');
function opened(side='long',partial=false){
 const sign=side==='long'?1:-1,entry=100,qty=60;
 const s={...initialState(t),day:'2026-10-08',last_candle:t-60000,balance:497,total_fees:3};
 s.position={side,entry,qty,original_qty:qty,balance_before_entry:500,margin:50,
  entry_fee:3,funding:0,exit_fees:0,fills:[],opened_at:t,profit_lock_roi:1,
  stop:100-sign,target:100+sign*2,strategy_version:6};
 if(partial)s.position.scale_out={targets:[.2,.4,.6].map(ratio=>({ratio,price:100+sign*ratio})),filled:0,runner_levels:[],runner_crossed:0,peak:100+sign*2};
 return s;
}
function bar(s,open,high,low,close,funding=[]){
 const b=[s.last_candle+60000,open,high,low,close,1];return step(s,b,b,funding);
}
for(const side of ['long','short']){
 test(`${side} locks $50 net on $50 margin including both fees and slippage`,()=>{
  const s=opened(side),p=s.position,sign=side==='long'?1:-1,level=profitLockPrice(p,s.balance,s.config);
  const r=bar(s,100+sign*.5,Math.max(level,100+sign*.5),Math.min(level,100+sign*.5),level);
  assert.equal(r.events[0].reason,'100% net margin profit locked');
  assert.ok(Math.abs(r.state.balance-550)<1e-9);
  assert.ok(Math.abs(r.events[0].net_pnl-50)<1e-9);
 });
 test(`${side} partial exits retain the initial stop until net 100%, then close only the remainder`,()=>{
  let s=opened(side,true),sign=side==='long'?1:-1;
  for(const change of [.21,.41,.61]){
   const a=100+sign*(change-.02),b=100+sign*change;
   s=bar(s,a,Math.max(a,b),Math.min(a,b),b).state;
   assert.equal(s.position.stop,100-sign);
  }
  assert.equal(s.position.fills.length,3);assert.equal(s.position.qty,15);
  const level=profitLockPrice(s.position,s.balance,s.config);
  const a=level-sign*.02;
  // Extend the frozen endpoint so this fixture isolates the net-profit lock.
  s.position.scale_out.peak=level+sign;
  const r=bar(s,a,Math.max(a,level),Math.min(a,level),level);
  assert.ok(Math.abs(r.events[0].net_pnl-50)<1e-9);
  assert.equal(r.events[0].fills.length,4);
 });
}
test('old stop wins if the same minute touches stop and net-profit lock',()=>{
 const r=bar(opened(),100,102,98.9,101);
 assert.equal(r.events[0].reason,'stop loss');assert.ok(r.events[0].net_pnl<0);
});
test('net lock precedes a farther partial target and funding changes its level',()=>{
 let s=opened('long',true);s.position.scale_out.targets[0].price=102;
 const old=profitLockPrice(s.position,s.balance,s.config);
 const rate=.0001,cost=s.position.qty*100.5*rate;
 const level=profitLockPrice(s.position,s.balance-cost,s.config);
 assert.ok(level>old);
 const r=bar(s,100.5,103,100.4,102,[{timestamp:t,fundingRate:rate}]);
 assert.equal(r.events[0].fills.length,1);assert.ok(Math.abs(r.events[0].net_pnl-50)<1e-9);
});

test('a nearer frozen endpoint closes before a farther net lock in the same minute',()=>{
 const s=opened('long',true);s.position.scale_out.peak=100.8;
 const r=bar(s,100.1,104,100.1,103);
 assert.equal(r.events[0].reason,'Fibonacci swing endpoint');
 assert.equal(r.events[0].fills.length,4);
 assert.ok(r.events[0].net_pnl<50);
});
