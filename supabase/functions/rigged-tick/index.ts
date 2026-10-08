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
  return response.json();
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
    const [candles,marks,funding]=await Promise.all([
      exchange.fetchOHLCV(symbol,'1m',since,500),
      exchange.fetchMarkOHLCV(symbol,'1m',since,500),
      exchange.fetchFundingRateHistory(symbol,since,1000),
    ]);
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
    return Response.json({ok:true,processed,last_candle:state.last_candle});
  } catch(error) {
    // Never log request headers, scheduler tokens, or database keys.
    console.error('Rigged tick failed:',error instanceof Error?error.message:'unknown error');
    return Response.json({ok:false,error:'Tick failed; saved state is preserved. Inspect function logs.'},{status:503});
  }
});
