import ccxt from 'npm:ccxt@4.5.0';
import { CONFIG, initialState, step } from './engine.mjs';

// This function receives only a scheduler token; it never accepts trading instructions.
const url = Deno.env.get('SUPABASE_URL')!;
const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
async function db(path: string, body?: unknown) {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { apikey:key, Authorization:`Bearer ${key}`, 'Content-Type':'application/json' },
    body:body === undefined ? undefined : JSON.stringify(body), signal:AbortSignal.timeout(15000),
  });
  if(!response.ok) throw Error(`Database request failed (${response.status})`);
  // PostgREST can return an empty body for void RPCs.
  const bodyText=await response.text();
  return bodyText.trim()?JSON.parse(bodyText):null;
}
Deno.serve(async request => {
  try {
    if(request.method!=='POST') return new Response('Method not allowed',{status:405});
    const token=request.headers.get('x-rigged-token');
    if(!token || !(await db('rpc/rigged_authorize',{token}))) return new Response('Unauthorized',{status:401});
    const started=Date.now();
    const rows=await db('rigged_runs?id=eq.main&select=state,version');
    let state=rows[0]?.state??initialState(started,CONFIG);
    let version=rows[0]?.version??-1;
    // First invocation warms up today's range. Trades start only after the run begins.
    const midnight=Date.UTC(new Date(started).getUTCFullYear(),new Date(started).getUTCMonth(),new Date(started).getUTCDate());
    const since=state.last_candle===null?midnight:state.last_candle+60000;
    const exchange=new ccxt.binanceusdm({enableRateLimit:true,timeout:15000});
    const symbol='BTC/USDT:USDT';
    const [candles,marks,funding,hourly]=await Promise.all([
      exchange.fetchOHLCV(symbol,'1m',since,500),
      exchange.fetchMarkOHLCV(symbol,'1m',since,500),
      exchange.fetchFundingRateHistory(symbol,since,1000),
      exchange.fetchOHLCV(symbol,'1h',midnight-2*86400000,72),
    ]);
    // Hydrate existing runs only with hourly information already known at the watermark.
    if(!Array.isArray(state.hourly_bars)) {
      const day=new Date(since).toISOString().slice(0,10);
      state.hourly_bars=hourly.filter((x:any)=>x[0]+3600000<=since && new Date(x[0]).toISOString().slice(0,10)===day)
        .map((x:any)=>({time:x[0],open:x[1],high:x[2],low:x[3],close:x[4],volume:x[5]}));
    }
    const markByTime=new Map(marks.map((x:any)=>[x[0],x]));
    const trades:any[]=[], samples:any[]=[];
    let processed=0;
    for(const candle of candles) {
      if(candle[0]<since || candle[0]+60000>started) continue;
      const mark=markByTime.get(candle[0]);
      if(!mark) throw Error('Missing mark-price candle');
      if(state.last_candle===null && candle[0]!==midnight) throw Error('Missing UTC midnight observation');
      const result=step(state,candle,mark,funding);
      state=result.state;trades.push(...result.events);if(result.sample)samples.push(result.sample);processed++;
    }
    if(processed || version===-1) await db('rpc/rigged_commit',{expected_version:version,next_state:state,trades,samples});
    const chartCandles=hourly.map((x:any)=>({time:x[0],open:x[1],high:x[2],low:x[3],close:x[4],volume:x[5],is_closed:x[0]+3600000<=started}));
    await db('rpc/rigged_save_candles',{candles:chartCandles,source_observed_at:new Date(started).toISOString()});
    return Response.json({ok:true,processed,last_candle:state.last_candle});
  } catch(error) {
    // Never log request headers, scheduler tokens, or database keys.
    console.error('Rigged tick failed:',error instanceof Error?error.message:'unknown error');
    return Response.json({ok:false,error:'Tick failed; saved state is preserved. Inspect function logs.'},{status:503});
  }
});
