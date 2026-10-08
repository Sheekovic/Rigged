import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CONFIG,initialState,step} from '../supabase/functions/rigged-tick/engine.mjs';
const noon=Date.parse('2026-10-08T12:00:00Z');
const config={...CONFIG,fee_rate:0,slippage:0};
function ready(overrides={}) {
  return {...initialState(noon,config),day:'2026-10-08',range:{low:100,high:110},observation_count:720,...overrides};
}
function bar(t,close,low=close,high=close) {return [t,close,high,low,close,1];}
function tick(s,b,m=b,f=[]) {return step(s,b,m,f);}
test('allocates exactly 10% and opens long only at a completed candle close',()=>{
  const {state}=tick(ready(),bar(noon,100));
  assert.equal(state.position.side,'long');assert.equal(state.position.margin,10);
  assert.equal(state.position.qty*state.position.entry,1200);
  assert.equal(state.position.opened_at,noon+60000);
});
test('short near the high uses the same profit target',()=>{
  const opened=tick(ready(),bar(noon,110)).state;
  assert.equal(opened.position.side,'short');
  const result=tick(opened,[noon+60000,110,110,108,108,1]);
  assert.equal(result.events[0].reason,'take profit');
  assert.ok(Math.abs(result.state.balance-120)<1e-8);
});
test('stop costs 10% with ideal fills, and next trade compounds current balance',()=>{
  const opened=tick(ready(),bar(noon,100)).state;
  const result=tick(opened,[noon+60000,100,100,99,99,1]);
  assert.equal(result.events[0].reason,'stop loss');assert.ok(Math.abs(result.state.balance-90)<1e-8);
  assert.equal(result.state.position,null);
  const next=tick({...result.state,last_candle:noon+5*60000},bar(noon+6*60000,100)).state;
  assert.ok(Math.abs(next.position.margin-9)<1e-8);
});
test('same candle target and stop resolves as loss',()=>{
  const opened=tick(ready(),bar(noon,100)).state;
  const result=tick(opened,bar(noon+60000,100,99,102));
  assert.equal(result.events[0].reason,'stop loss');
});
test('gap through stop fills at worse opening price',()=>{
  const opened=tick(ready(),bar(noon,100)).state;
  const result=tick(opened,bar(noon+60000,97));
  assert.equal(result.events[0].exit,97);assert.equal(result.state.balance,64);
});
test('cross liquidation can consume the entire balance',()=>{
  const opened=tick(ready(),bar(noon,100)).state;
  const result=tick(opened,bar(noon+60000,100),bar(noon+60000,100,90,100));
  assert.equal(result.state.balance,0);assert.equal(result.events[0].reason,'cross liquidation (approx.)');
  assert.equal(result.state.phase,'Account depleted');
});
test('cannot trade with an incomplete observation window or during warm-up',()=>{
  assert.equal(tick(ready({observation_count:719}),bar(noon,100)).state.position,null);
  assert.equal(tick(ready({start_candle:noon+60000}),bar(noon,100)).state.position,null);
});
test('no future range leakage: outside-range price does not enter',()=>{
  const result=tick(ready(),bar(noon,99,99,110));
  assert.equal(result.state.position,null);assert.deepEqual(result.state.range,{low:100,high:110});
});
test('fees, funding and equity are reconciled against account balance',()=>{
  const opened=tick(ready({config:{...config,fee_rate:0.0005}}),bar(noon,100)).state;
  assert.equal(opened.balance,99.4);
  const result=tick(opened,bar(noon+60000,102,100,102),undefined,[{timestamp:noon+60000,fundingRate:0.0001}]);
  const event=result.events[0];
  assert.ok(Math.abs((result.state.balance-100)-event.net_pnl)<1e-8);
  assert.ok(event.fees>1.2);assert.ok(Math.abs(event.funding-0.1224)<1e-12);
});
test('duplicates and missing candles cannot silently advance the simulation',()=>{
  const s=tick(ready(),bar(noon,100)).state;
  assert.throws(()=>tick(s,bar(noon,100)),/gap or duplicate/);
  assert.throws(()=>tick(s,bar(noon+120000,100)),/gap or duplicate/);
});
test('drawdown persists after recovery',()=>{
  const s=tick(ready(),bar(noon,100)).state;
  const r=tick(s,[noon+60000,100,100,99,99,1]).state;
  assert.ok(Math.abs(r.max_drawdown-0.1)<1e-8);
  assert.equal(r.peak,100);
});
test('overlapping entry zones do not choose an arbitrary direction',()=>{
  assert.equal(tick(ready({range:{low:100,high:100.05}}),bar(noon,100.02)).state.position,null);
});
test('an existing long blocks further entries and an opposite short signal',()=>{
  let s=tick(ready({range:{low:100,high:100.2}}),bar(noon,100)).state;
  const original=structuredClone(s.position);
  for(let i=1;i<=10;i++) {
    s=tick(s,bar(noon+i*60000,i%2?100:100.2)).state;
    assert.deepEqual(s.position,original);assert.equal(s.entries_today,1);
  }
});
test('a closing candle cannot also open another position',()=>{
  const s=tick(ready(),bar(noon,100)).state;
  const result=tick(s,[noon+60000,100,110,100,110,1]);
  assert.equal(result.events.length,1);assert.equal(result.state.position,null);
  assert.equal(result.state.entries_today,1);
});
test('sixth entry is allowed, seventh is blocked for either direction',()=>{
  const sixth=tick(ready({entries_today:5}),bar(noon,100)).state;
  assert.ok(sixth.position);assert.equal(sixth.entries_today,6);
  for(const price of [100,110]) {
    const blocked=tick(ready({entries_today:6}),bar(noon,price)).state;
    assert.equal(blocked.position,null);assert.equal(blocked.phase,'Daily entry limit reached');
  }
});
test('UTC midnight resets daily count while preserving a carried position',()=>{
  const midnight=Date.parse('2026-10-09T00:00:00Z');
  const opened=tick(ready({entries_today:5}),bar(noon,100)).state;
  const carried=tick({...opened,last_candle:midnight-60000},bar(midnight,100)).state;
  assert.equal(carried.entries_today,0);assert.deepEqual(carried.position,opened.position);
  const next=tick({...carried,last_candle:midnight+12*3600000-60000,observation_count:720,range:{low:100,high:110},position:null},bar(midnight+12*3600000,100)).state;
  assert.ok(next.position);assert.equal(next.entries_today,1);
});
test('the final UTC minute cannot create an entry in the observation period',()=>{
  assert.equal(tick(ready(),bar(Date.parse('2026-10-08T23:59:00Z'),100)).state.position,null);
});
