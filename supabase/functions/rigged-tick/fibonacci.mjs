export const FIB_RATIOS = Object.freeze([0,0.236,0.382,0.5,0.618,0.786,1]);
// Only completed hourly bars from the selected UTC day may establish a setup.
export function buildFibonacci(bars, day, asOf) {
  const eligible=bars.filter(b=>b.time+3600000<=asOf && new Date(b.time).toISOString().slice(0,10)===day);
  if(eligible.length<2) return null;
  let lowBar=eligible[0],highBar=eligible[0];
  for(const b of eligible) {
    if(b.low<lowBar.low)lowBar=b;
    if(b.high>highBar.high)highBar=b;
  }
  if(highBar.high<=lowBar.low || highBar.time===lowBar.time)return null;
  const direction=lowBar.time<highBar.time?'up':'down';
  const start=direction==='up'?lowBar.low:highBar.high;
  const end=direction==='up'?highBar.high:lowBar.low;
  return {day,direction,low:lowBar.low,high:highBar.high,
    start_time:direction==='up'?lowBar.time:highBar.time,
    end_time:direction==='up'?highBar.time:lowBar.time,
    start,end,as_of:asOf,
    levels:FIB_RATIOS.map(ratio=>({ratio,price:end+(start-end)*ratio}))};
}
export function advanceHourly(state,candle) {
  const [time,open,high,low,close,volume=0]=candle;
  const hour=Math.floor(time/3600000)*3600000;
  if(state.hourly_building?.time!==hour) {
    state.hourly_building={time:hour,open,high,low,close,volume,count:0,complete_start:time===hour};
  }
  const b=state.hourly_building;
  b.high=Math.max(b.high,high);b.low=Math.min(b.low,low);b.close=close;b.volume+=b.count?volume:0;b.count++;
  if(time+60000===hour+3600000 && b.complete_start && b.count===60) {
    const {count,complete_start,...bar}=b;
    state.hourly_bars=[...(state.hourly_bars??[]).filter(x=>x.time!==hour),bar].slice(-24);
  }
  state.fib=buildFibonacci(state.hourly_bars??[],state.day,time+60000);
}
export function fibonacciPlan(fib,side,entry,config) {
  if(!fib || (side==='long'?fib.direction!=='up':fib.direction!=='down'))return null;
  const boundary=fib.levels.find(x=>x.ratio===0.618).price;
  const deep=side==='long'?entry>=fib.low && entry<=boundary:entry<=fib.high && entry>=boundary;
  if(!deep)return null;
  const recovery=fib.levels.find(x=>x.ratio===0.382).price;
  const invalidation=side==='long'?fib.low*(1-config.fib_stop_buffer):fib.high*(1+config.fib_stop_buffer);
  const roiTarget=entry*(1+(side==='long'?1:-1)*config.target_roi/config.leverage);
  const roiStop=entry*(1+(side==='long'?1:-1)*config.stop_roi/config.leverage);
  const target=side==='long'?Math.min(recovery,roiTarget):Math.max(recovery,roiTarget);
  const stop=side==='long'?Math.max(invalidation,roiStop):Math.min(invalidation,roiStop);
  if(side==='long'?(stop>=entry||target<=entry):(stop<=entry||target>=entry))return null;
  return {fib:structuredClone(fib),target,stop,
    target_reason:target===roiTarget?'take profit':'Fibonacci recovery',
    stop_reason:stop===roiStop?'stop loss':'Fibonacci invalidation'};
}
