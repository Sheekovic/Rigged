import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildFibonacci,fibonacciPlan,advanceHourly} from '../supabase/functions/rigged-tick/fibonacci.mjs';
import {CONFIG,initialState,step} from '../supabase/functions/rigged-tick/engine.mjs';
const day='2026-10-08', midnight=Date.parse(day+'T00:00:00Z'),noon=midnight+12*3600000;
const bars=[{time:midnight,low:100,high:105},{time:midnight+3600000,low:103,high:110}];
const fib=buildFibonacci(bars,day,noon);
const config={...CONFIG,starting_capital:100,fee_rate:0,slippage:0};
function ready(extra={}) {return {...initialState(noon,config),day,range:{low:100,high:110},observation_count:720,hourly_bars:bars,...extra};}
function bar(time,price,low=price,high=price){return [time,price,high,low,price,1];}
test('upward swing retracements run from high back toward low',()=>{
 assert.equal(fib.direction,'up');assert.equal(fib.levels[0].price,110);assert.equal(fib.levels.at(-1).price,100);
 assert.ok(Math.abs(fib.levels.find(x=>x.ratio===0.618).price-103.82)<1e-9);
});
test('downward swing reverses retracement direction',()=>{
 const f=buildFibonacci([{time:midnight,high:110,low:105},{time:midnight+3600000,high:108,low:100}],day,noon);
 assert.equal(f.direction,'down');assert.equal(f.levels[0].price,100);assert.equal(f.levels.at(-1).price,110);
 assert.ok(fibonacciPlan(f,'short',110,config));assert.ok(fibonacciPlan(f,'long',100,config));
});
test('forming hours and later UTC days cannot leak into the grid',()=>{
 assert.deepEqual(buildFibonacci([...bars,{time:noon,low:1,high:999}],day,noon),fib);
 assert.deepEqual(buildFibonacci([...bars,{time:midnight+86400000,low:1,high:999}],day,midnight+2*86400000),{...fib,as_of:midnight+2*86400000});
});
test('same-hour extremes do not define ordered Fibonacci anchors',()=>{
 assert.equal(buildFibonacci([{time:midnight,low:100,high:110},{time:midnight+3600000,low:103,high:108}],day,noon),null);
});
test('partial hourly aggregation is excluded; complete hour has all 60 bars',()=>{
 const s={day,hourly_bars:[]};
 for(let i=1;i<60;i++)advanceHourly(s,bar(midnight+i*60000,100));
 assert.equal(s.hourly_bars.length,0);
 for(let i=0;i<60;i++)advanceHourly(s,bar(midnight+3600000+i*60000,100+i/100));
 assert.equal(s.hourly_bars.length,1);assert.equal(s.hourly_bars[0].volume,60);
});
test('entry uses the range extreme without requiring Fibonacci direction or retracement',()=>{
 const long=step(ready(),bar(noon,100),bar(noon,100)).state;
 assert.equal(long.position.side,'long');assert.ok(long.position.fib);assert.equal(long.position.strategy_version,5);
 assert.equal(step(ready(),bar(noon,110),bar(noon,110)).state.position.side,'short');
 assert.ok(fibonacciPlan(fib,'long',105,config));
});

test('missing anchors and targets behind entry cannot block a range entry',()=>{
 const opened=step(ready({hourly_bars:[]}),bar(noon,100),bar(noon,100)).state;
 assert.equal(opened.position.side,'long');assert.equal(opened.position.fib,null);
 assert.equal(fibonacciPlan(fib,'long',108,config).target,108*(1+2/120));
});

test('version 3 retains its original filter until the versioned rule change',()=>{
 const legacy={...config,version:3};delete legacy.fib_entry_filter;
 assert.equal(fibonacciPlan(fib,'short',110,legacy),null);
 assert.equal(fibonacciPlan(null,'long',100,legacy),null);
});
test('Fibonacci invalidation exits before the wider ROI loss limit',()=>{
 const opened=step(ready(),bar(noon,100),bar(noon,100)).state;
 assert.equal(opened.position.stop,99.9);
 const result=step(opened,[noon+60000,100,100,99.8,99.8,1],[noon+60000,100,100,99.8,99.8,1]);
 assert.equal(result.events[0].reason,'Fibonacci invalidation');assert.ok(result.state.balance>98.7);
 assert.equal(result.state.position,null);assert.equal(result.state.entries_today,1);
});
test('profit uses the nearer recovery level or 200% ROI ceiling',()=>{
 assert.ok(Math.abs(fibonacciPlan(fib,'long',100,config).target-(100*(1+2/120)))<1e-9);
 const small=buildFibonacci([{time:midnight,low:100,high:100.5},{time:midnight+3600000,low:100.2,high:101}],day,noon);
 const p=fibonacciPlan(small,'long',100,config);assert.equal(p.target_reason,'Fibonacci recovery');assert.equal(p.target,100.618);
});
test('open-trade levels remain frozen when newer hourly anchors change',()=>{
 const opened=step(ready(),bar(noon,100),bar(noon,100)).state;
 const original=structuredClone(opened.position);
 const changed={...opened,hourly_bars:[...bars,{time:noon-3600000,high:112,low:101}]};
 const result=step(changed,bar(noon+60000,100.05),bar(noon+60000,100.05)).state;
 assert.deepEqual(result.position,original);assert.equal(result.fib.high,112);
});
test('Fibonacci exits cannot bypass cooldown or the daily entry limit',()=>{
 const opened=step(ready({entries_today:5}),bar(noon,100),bar(noon,100)).state;
 const closed=step(opened,[noon+60000,100,100,99.8,99.8,1],[noon+60000,100,100,99.8,99.8,1]).state;
 const next=step(closed,bar(noon+120000,100),bar(noon+120000,100)).state;
 assert.equal(next.position,null);assert.equal(next.entries_today,6);
});
test('short position uses mirrored Fibonacci invalidation and records its anchors',()=>{
 const hourly_bars=[{time:midnight,low:105,high:110},{time:midnight+3600000,low:100,high:108}];
 const opened=step(ready({hourly_bars}),bar(noon,110),bar(noon,110)).state;
 assert.equal(opened.position.side,'short');assert.ok(Math.abs(opened.position.stop-110.11)<1e-9);
 const b=[noon+60000,110,110.2,110,110.2,1];
 const result=step(opened,b,b);
 assert.equal(result.events[0].reason,'Fibonacci invalidation');assert.equal(result.events[0].fib.direction,'down');
 assert.equal(result.events[0].strategy_version,5);assert.equal(result.state.position,null);
});
test('lower re-entry closes first, waits the full cooldown, and consumes a new entry',()=>{
 let s=step(ready(),bar(noon,100.08),bar(noon,100.08)).state;
 const entry=s.position.entry;
 const loss=[noon+60000,100.08,100.08,99.8,99.8,1];s=step(s,loss,loss).state;
 assert.equal(s.position,null);
 for(let i=2;i<=5;i++){s=step(s,bar(noon+i*60000,100),bar(noon+i*60000,100)).state;assert.equal(s.position,null);}
 s=step(s,bar(noon+6*60000,100),bar(noon+6*60000,100)).state;
 assert.ok(s.position.entry<entry);assert.equal(s.entries_today,2);assert.ok(s.position.margin<10);
});
