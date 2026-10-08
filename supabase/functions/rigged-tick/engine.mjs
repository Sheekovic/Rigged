import {advanceHourly,fibonacciPlan} from './fibonacci.mjs';
export const CONFIG = Object.freeze({
  version: 5, margin_mode: 'cross', range_mode: '00:00-12:00 UTC', timezone: 'UTC',
  leverage: 120, allocation: 0.1, target_roi: 2, stop_roi: -1,
  entry_tolerance: 0.001, fee_rate: 0.0005, slippage: 0.0001,
  maintenance_rate: 0.004, minimum_notional: 100, cooldown_minutes: 5, max_daily_entries: 6,
  fib_enabled: true, fib_entry_filter: false, fib_partial_exits: true, fib_stop_buffer: 0.001,
});
const iso = ms => new Date(ms).toISOString();
export function initialState(now, config = CONFIG) {
  return {config: {...config}, started_at:iso(now), start_candle:Math.ceil(now/60000)*60000,
    last_candle:null, balance:100, equity:100, peak:100, max_drawdown:0,
    position:null, closed:0, wins:0, price:null, phase:'Observing the range',
    day:null, range:null, observation_count:0, entries_today:0, cooldown_until:0, total_fees:0,
    total_funding:0, candles:[], history:[]};
}
export function step(state, candle, mark, funding = []) {
  const s = structuredClone(state), c = s.config;
  const [time, open, high, low, close] = candle;
  if (![time,open,high,low,close,...mark.slice(0,5)].every(Number.isFinite) || time!==mark[0] || low<=0 || high<low || open<low || open>high || close<low || close>high) throw Error('Invalid candle');
  if (s.last_candle !== null && time !== s.last_candle + 60000) throw Error('Candle gap or duplicate: refusing to skip market history');
  const day = iso(time).slice(0,10), hour = new Date(time).getUTCHours();
  const events = [];
  if(s.day!==day) {s.day=day;s.range=null;s.observation_count=0;s.entries_today=0;s.hourly_bars=[];s.hourly_building=null;s.fib=null;}
  advanceHourly(s,candle);
  if(hour<12) {
    s.range={low:Math.min(s.range?.low??low,low),high:Math.max(s.range?.high??high,high)};
    s.observation_count++;
  }
  s.price=close;
  // Warm-up candles establish the range, but never create retrospective trades.
  const active = time >= s.start_candle;
  if(active && s.position) {
    const p=s.position, sign=p.side==='long'?1:-1;
    for(const f of funding) if(f.timestamp>=time && f.timestamp<time+60000) {
      // Funding is settled at the start of this one-minute bar; mark close is a proxy.
      const cost=p.qty*mark[1]*f.fundingRate*sign;
      s.balance-=cost;p.funding+=cost;s.total_funding+=cost;
    }
    const target=p.target??p.entry*(1+sign*c.target_roi/c.leverage);
    const stop=p.stop??p.entry*(1+sign*c.stop_roi/c.leverage);
    const worstMark=sign===1?mark[3]:mark[2];
    const worstEquity=s.balance+sign*p.qty*(worstMark-p.entry);
    const liquidation=worstEquity<=p.qty*worstMark*c.maintenance_rate;
    const hitStop=sign===1?low<=stop:high>=stop;
    const hitTarget=sign===1?high>=target:low<=target;
    let reason=null, exit=null;
    // Bar ordering is unknown: always resolve adverse outcomes before profit.
    if(liquidation) {reason='cross liquidation (approx.)';exit=worstMark;}
    else if(hitStop) {reason=p.stop_reason??'stop loss';exit=sign===1?Math.min(open,stop):Math.max(open,stop);}
    else if(!p.scale_out && hitTarget) {reason=p.target_reason??'take profit';exit=sign===1?Math.max(open,target):Math.min(open,target);}
    if(!reason && p.scale_out) {
      const plan=p.scale_out;
      const hit=price=>sign===1?high>=price:low<=price;
      const raiseStop=price=>{p.stop=sign===1?Math.max(p.stop,price):Math.min(p.stop,price);p.stop_reason='Fibonacci trailing stop';};
      const raisedStopTouched=()=>sign===1?low<=p.stop:high>=p.stop;
      while(plan.filled<plan.targets.length && hit(plan.targets[plan.filled].price)) {
        const point=plan.targets[plan.filled];
        const raw=sign===1?Math.max(open,point.price):Math.min(open,point.price);
        const fillPrice=raw*(1-sign*c.slippage),qty=p.original_qty*.25,fee=qty*fillPrice*c.fee_rate;
        s.balance+=sign*qty*(fillPrice-p.entry)-fee;s.total_fees+=fee;
        p.qty-=qty;p.exit_fees=(p.exit_fees??0)+fee;
        p.fills.push({closed_at:iso(time+60000),price:fillPrice,qty,fraction:.25,fees:fee,reason:`Fibonacci ${(point.ratio*100).toFixed(1)}%`});
        const nextStop=plan.filled===0?p.entry:plan.targets[plan.filled-1].price;
        plan.filled++;raiseStop(nextStop);
        // Unknown intrabar ordering: raised stop wins over subsequent targets.
        if(raisedStopTouched()){reason=p.stop_reason;exit=p.stop;break;}
      }
      if(!reason && plan.filled===plan.targets.length) {
        while(plan.runner_crossed<plan.runner_levels.length && hit(plan.runner_levels[plan.runner_crossed].price)) {
          const nextStop=plan.runner_crossed===0?plan.targets.at(-1).price:plan.runner_levels[plan.runner_crossed-1].price;
          plan.runner_crossed++;raiseStop(nextStop);
          if(raisedStopTouched()){reason=p.stop_reason;exit=p.stop;break;}
        }
        if(!reason&&hit(plan.peak)){reason='Fibonacci swing endpoint';exit=sign===1?Math.max(open,plan.peak):Math.min(open,plan.peak);}
      }
      p.target=plan.targets[plan.filled]?.price??plan.peak;
    }
    if(reason) {
      exit*=1-sign*c.slippage;
      const exitFee=p.qty*exit*c.fee_rate;
      const gross=sign*p.qty*(exit-p.entry);
      const before=s.balance;
      s.balance=liquidation?0:Math.max(0,s.balance+gross-exitFee);
      const net=p.balance_before_entry!==undefined?s.balance-p.balance_before_entry:s.balance-before-p.entry_fee-p.funding;
      const totalExitFees=(p.exit_fees??0)+exitFee;
      const fills=p.fills??[];
      fills.push({closed_at:iso(time+60000),price:exit,qty:p.qty,fraction:p.original_qty?p.qty/p.original_qty:1,fees:exitFee,reason});
      const averageExit=fills.reduce((sum,f)=>sum+f.price*f.qty,0)/fills.reduce((sum,f)=>sum+f.qty,0);
      const event={id:`main:${p.opened_at}`,run_id:'main',opened_at:iso(p.opened_at),closed_at:iso(time+60000),
        side:p.side,entry:p.entry,exit:averageExit,margin:p.margin,net_pnl:net,fees:p.entry_fee+totalExitFees,funding:p.funding,reason,
        strategy_version:p.strategy_version??2,fib:p.fib??null,fills};
      events.push(event);s.closed++;if(net>0)s.wins++;
      s.total_fees+=exitFee;s.position=null;s.cooldown_until=time+60000+c.cooldown_minutes*60000;
    }
  }
  // Signal is evaluated at the completed candle close; exits begin with the next candle.
  const ready=s.observation_count===720 && hour>=12 && s.range && s.range.high>s.range.low;
  const dailyLimit=c.max_daily_entries??6;
  const entriesToday=s.entries_today??0;
  if(active && !s.position && !events.length && ready && entriesToday<dailyLimit && iso(time+60000).slice(0,10)===day && time+60000>=s.cooldown_until) {
    const nearLow=close>=s.range.low && close<=s.range.low*(1+c.entry_tolerance);
    const nearHigh=close<=s.range.high && close>=s.range.high*(1-c.entry_tolerance);
    if(nearLow!==nearHigh) {
      const margin=s.balance*c.allocation, notional=margin*c.leverage;
      if(notional>=c.minimum_notional) {
        const side=nearLow?'long':'short', sign=nearLow?1:-1;
        const entry=close*(1+sign*c.slippage),qty=notional/entry,entryFee=notional*c.fee_rate;
        const plan=c.fib_enabled?fibonacciPlan(s.fib,side,entry,c):{};
        if(plan) {
          const beforeEntry=s.balance;s.balance-=entryFee;s.total_fees+=entryFee;
          s.position={side,entry,qty,original_qty:qty,balance_before_entry:beforeEntry,fills:[],exit_fees:0,margin,entry_fee:entryFee,funding:0,opened_at:time+60000,strategy_version:c.version,...plan};
          if(s.position.scale_out)s.position.target=s.position.scale_out.targets[0].price;
          s.entries_today=entriesToday+1;
        }
      }
    }
  }
  const unrealized=s.position?(s.position.side==='long'?1:-1)*s.position.qty*(mark[4]-s.position.entry):0;
  s.equity=Math.max(0,s.balance+unrealized);
  s.peak=Math.max(s.peak,s.equity);s.max_drawdown=Math.max(s.max_drawdown,1-s.equity/s.peak);
  const fibEntryFilter=c.fib_enabled&&(c.fib_entry_filter??(c.version<=3));
  s.phase=s.balance===0?'Account depleted':s.balance*c.allocation*c.leverage<c.minimum_notional&&!s.position?'Below minimum trade size':s.position?`${s.position.side==='long'?'Long':'Short'} position open`:hour<12?'Observing until 12:00 UTC':!ready?'Incomplete range · waiting for next UTC day':s.entries_today>=dailyLimit?'Daily entry limit reached':fibEntryFilter&&!s.fib?'Waiting for unambiguous hourly anchors':fibEntryFilter?'Waiting for range + Fibonacci confirmation':'Waiting near a range extreme';
  s.last_candle=time;
  return {state:s,events,sample:active?{run_id:'main',observed_at:iso(time+60000),equity:s.equity,price:close}:null};
}
