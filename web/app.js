'use strict';
const config = window.RIGGED_CONFIG;
const $ = (id) => document.getElementById(id);
const money = (n) => Number(n).toLocaleString('en-US', {style:'currency', currency:'USD', maximumFractionDigits:2});
const pct = (n) => `${Number(n).toFixed(2)}%`;
let ledger = [];
let lastSuccess = 0;
function chart(samples) {
  const values = samples.map(x => Number(x.equity)).filter(Number.isFinite);
  $('chart-empty').style.display = values.length < 2 ? 'flex' : 'none';
  if (values.length < 2) return;
  const min = Math.min(...values), max = Math.max(...values), span = Math.max(max-min, 1);
  const points = values.map((v,i) => `${(i/(values.length-1)*850+25).toFixed(2)},${(265-(v-min)/span*230).toFixed(2)}`);
  $('chart-path').setAttribute('d', `M${points.join(' L')}`);
  $('chart-fill').setAttribute('d', `M25,290 L${points.join(' L')} L875,290 Z`);
  $('chart-lines').replaceChildren();
  for (let i=0;i<4;i++) {
    const line = document.createElementNS('http://www.w3.org/2000/svg','line');
    Object.entries({x1:25,x2:875,y1:35+i*77,y2:35+i*77,stroke:'#30372d','stroke-dasharray':'4 8'}).forEach(([k,v])=>line.setAttribute(k,v));
    $('chart-lines').append(line);
  }
  $('equity-chart').setAttribute('aria-label', `Recorded paper equity: minimum ${money(min)}, maximum ${money(max)}; equally spaced one-minute samples.`);
  $('chart-range').textContent = `${money(min)} – ${money(max)} · recent samples`;
}
function render(state, trades, samples, updated) {
  const s = state, c = s.config;
  $('equity').textContent = money(s.equity);
  $('return').textContent = `${pct((s.equity/100-1)*100)} since $100 start`;
  window.RIGGED_STATE=s;
  if(!window.RIGGED_MARKET_LIVE) {
    $('price').textContent = s.price ? money(s.price) : '—';
    $('price-source').textContent='Supabase · last recorded futures close';
  }
  window.dispatchEvent(new CustomEvent('rigged-state',{detail:s}));
  $('win-rate').textContent = s.closed ? pct(s.wins/s.closed*100) : '—';
  $('trade-count').textContent = `${s.closed} closed trades · ${s.wins} wins`;
  $('drawdown').textContent = pct(s.max_drawdown*100);
  $('range-low').textContent = s.range ? money(s.range.low) : '—';
  $('range-high').textContent = s.range ? money(s.range.high) : '—';
  if(s.range && s.range.high > s.range.low) $('range-marker').style.left = `${Math.max(0,Math.min(100,(s.price-s.range.low)/(s.range.high-s.range.low)*100))}%`;
  $('phase').textContent = s.phase;
  $('position').textContent = s.position ? `${s.position.side.toUpperCase()} position open` : 'No position open.';
  $('position-detail').textContent = s.position ? `Entry ${money(s.position.entry)} · Margin ${money(s.position.margin)} · Notional ${money(s.position.qty*s.position.entry)}${s.position.stop?` · Stop ${money(s.position.stop)} · Target ${money(s.position.target)}`:''}` : '';
  $('rules').textContent = `${c.margin_mode} · ${c.range_mode} · one position at a time · ${s.entries_today??0}/${c.max_daily_entries??6} entries today (UTC)`;
  $('assumptions').textContent = `Entry zone: ${pct(c.entry_tolerance*100)} from each extreme, within the observed range. Taker fee: ${pct(c.fee_rate*100)} each side of notional. Slippage: ${pct(c.slippage*100)} each fill. Maintenance margin assumption: ${pct(c.maintenance_rate*100)}. Historical funding is included. Targets use gross P&L / initial margin; net results deduct costs. ${c.margin_mode === 'cross' ? 'Cross collateral can lose more than the 10% allocation if a stop gaps.' : 'Isolated liquidation can occur before the intended −100% exit.'}`;
  $('started').textContent = `Started ${new Date(s.started_at).toLocaleString()}`;
  const age = Date.now()-Date.parse(updated);
  const marketAge = s.last_candle ? Date.now()-(s.last_candle+60000) : Infinity;
  const live = age < 180000 && marketAge < 180000;
  document.querySelector('.experiment').classList.toggle('live',live);
  $('connection').textContent = live ? 'RECORDING' : 'DATA STALE';
  $('updated').textContent = `Worker saved ${new Date(updated).toLocaleTimeString()}`;
  $('notice').textContent = live ? 'Live paper experiment · completed one-minute futures candles · simulated fills, not real orders.' : 'The worker or market data is behind. These are the last saved results; recording continues when the worker catches up.';
  ledger = trades;
  if (trades.length) {
    $('trades').replaceChildren();
    for(const t of trades) {
      const row = document.createElement('tr');
      [new Date(t.closed_at).toISOString().replace('T',' ').slice(0,19),t.side.toUpperCase(),`${money(t.entry)} → ${money(t.exit)}`,money(t.margin),money(t.net_pnl),t.reason,`v${t.strategy_version??2}`].forEach((value,i)=>{
        const cell=document.createElement('td');cell.textContent=value;
        if(i===4)cell.className=t.net_pnl>=0?'positive':'negative';row.append(cell);
      });
      $('trades').append(row);
    }
  }
  $('export').disabled = !trades.length;
  chart(samples.slice().reverse());
}
async function read(path) {
  const response = await fetch(`${config.supabaseUrl.replace(/\/$/,'')}/rest/v1/${path}`, {headers:{apikey:config.publishableKey}, signal:AbortSignal.timeout(12000),cache:'no-store'});
  if(!response.ok) throw new Error(`Supabase returned ${response.status}`);
  return response.json();
}
async function refresh() {
  try {
    const [runs,trades,samples] = await Promise.all([read('rigged_runs?id=eq.main&select=state,updated_at'),read('rigged_trades?run_id=eq.main&select=*&order=closed_at.desc&limit=200'),read('rigged_samples?run_id=eq.main&select=equity,observed_at&order=observed_at.desc&limit=720')]);
    if(!runs.length) { $('notice').textContent='Supabase is connected. No experiment has started yet; waiting for the worker.'; return; }
    render(runs[0].state,trades,samples,runs[0].updated_at);lastSuccess=Date.now();
  } catch(error) {
    document.querySelector('.experiment').classList.remove('live');
    $('connection').textContent='CONNECTION LOST';
    $('notice').textContent=`Cannot refresh the experiment. ${error.message}. ${lastSuccess?'Last recorded results remain visible.':'Check the public configuration and database setup.'}`;
  } finally {setTimeout(refresh,Math.max(5,config.pollSeconds||15)*1000);}
}
$('export').addEventListener('click',()=>{
  const keys=['closed_at','side','entry','exit','margin','net_pnl','fees','funding','reason','strategy_version'];
  const escape=(v)=>`"${String(v??'').replaceAll('"','""')}"`;
  const csv=[keys.join(','),...ledger.map(t=>keys.map(k=>escape(t[k])).join(','))].join('\r\n');
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download='rigged-recent-trades.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
if(config.supabaseUrl && config.publishableKey)refresh();
