import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CONFIG,initialState,step} from '../supabase/functions/rigged-tick/engine.mjs';
const noon=Date.parse('2026-10-08T12:00:00Z'),midnight=noon-12*3600000;
function setup(short=false,costs=false){
 const config={...CONFIG,starting_capital:100,target_roi:2,fee_rate:costs?.0005:0,slippage:costs?.0001:0};
 const bars=short?[{time:midnight,low:100.6,high:101},{time:midnight+3600000,low:100,high:100.5}]:[{time:midnight,low:100,high:100.5},{time:midnight+3600000,low:100.5,high:101}];
 const s={...initialState(noon,config),day:'2026-10-08',range:{low:100,high:101},observation_count:720,hourly_bars:bars};
 const p=short?101:100;return step(s,[noon,p,p,p,p,1],[noon,p,p,p,p,1]).state;
}
function tick(s,i,open,high,low,close,funding=[]){const b=[noon+i*60000,open,high,low,close,1];return step(s,b,b,funding);}
test('three quarter fills raise the stop and leave one runner, then close at the known endpoint',()=>{
 let s=setup();const original=s.position.original_qty;
 s=tick(s,1,100.2,100.25,100.1,100.24).state;
 assert.equal(s.position.fills.length,1);assert.equal(s.position.qty,original*.75);assert.equal(s.position.stop,100);
 s=tick(s,2,100.3,100.4,100.25,100.39).state;
 assert.equal(s.position.fills.length,2);assert.equal(s.position.stop,100.236);
 s=tick(s,3,100.45,100.51,100.4,100.5).state;
 assert.ok(Math.abs(s.position.qty-original*.25)<1e-12);assert.equal(s.position.stop,100.382);
 s=tick(s,4,100.6,100.63,100.55,100.62).state;assert.equal(s.position.stop,100.5);
 s=tick(s,5,100.7,100.8,100.65,100.79).state;assert.equal(s.position.stop,100.618);
 const result=tick(s,6,100.9,101,100.85,101);
 assert.equal(result.state.position,null);assert.equal(result.events.length,1);assert.equal(result.events[0].fills.length,4);
 assert.ok(Math.abs(result.events[0].fills.reduce((sum,f)=>sum+f.fraction,0)-1)<1e-12);
 assert.ok(Math.abs(result.state.balance-106.354)<1e-9);
});
test('short quarter exits mirror the stop progression',()=>{
 let s=setup(true);const q=s.position.original_qty;
 s=tick(s,1,100.8,100.9,100.75,100.76).state;
 assert.equal(s.position.qty,q*.75);assert.equal(s.position.stop,101);
 s=tick(s,2,100.7,100.75,100.6,100.61).state;
 assert.equal(s.position.stop,100.764);assert.equal(s.position.fills.length,2);
});
test('raised stop resolves before a higher target in an ambiguous minute',()=>{
 const result=tick(setup(),1,100.1,100.6,100,100.4);
 assert.equal(result.state.position,null);assert.equal(result.events[0].fills.length,2);
 assert.equal(result.events[0].fills[0].fraction,.25);assert.equal(result.events[0].fills[1].reason,'Fibonacci trailing stop');
});
test('funding, remaining quantity, all fees and weighted fills reconcile to the account',()=>{
 let s=setup(false,true);const before=s.balance;
 s=tick(s,1,100.2,100.25,100.1,100.24).state;
 assert.equal(s.position.fills.length,1);const q=s.position.qty;
 const result=tick(s,2,100.1,100.11,99.9,100.1,[{timestamp:noon+120000,fundingRate:.0001}]);
 const event=result.events[0];
 assert.ok(Math.abs(event.funding-q*100.1*.0001)<1e-12);
 assert.ok(Math.abs(event.net_pnl-(result.state.balance-100))<1e-9);
 assert.ok(Math.abs(result.state.total_fees-event.fees)<1e-9);
 assert.ok(before<100);assert.ok(event.fees>0);
 const weighted=event.fills.reduce((sum,f)=>sum+f.price*f.qty,0)/event.fills.reduce((sum,f)=>sum+f.qty,0);
 assert.equal(event.exit,weighted);
});
