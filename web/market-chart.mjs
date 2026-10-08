import {buildFibonacci} from './fibonacci.mjs';
const $=id=>document.getElementById(id);
const money=n=>Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const utc=ms=>new Date(ms).toISOString().slice(0,16).replace('T',' ')+' UTC';
const GOLD='#f0b90b',UP='#e5c663',DOWN='#d97768',MUTED='#807b67';
let bars=[],lastKline=0,lastMessage=0,lastTick=0,currentPrice=null,backoff=1000,socket,retryTimer;
let fibVisible=true,grid=null,position=null;
const candleMap=new Map();
function ohlc(b){if(b)$('market-ohlc').textContent=`${utc(b.time*1000)}   O ${money(b.open)}   H ${money(b.high)}   L ${money(b.low)}   C ${money(b.close)}`;}
// A native canvas renderer: no third-party chart library, no remote fonts.
class PixelChart {
 constructor(container){
  this.canvas=document.createElement('canvas');this.canvas.tabIndex=0;
  this.canvas.setAttribute('role','img');this.canvas.setAttribute('aria-label','Hourly Bitcoin candles. Drag to pan; scroll or use plus and minus to zoom; arrow keys pan; End follows live.');
  container.replaceChildren(this.canvas);this.ctx=this.canvas.getContext('2d');
  this.data=[];this.count=48;this.right=0;this.follow=true;this.hover=null;this.pointer=null;this.frame=null;
  new ResizeObserver(()=>this.resize()).observe(container);
  this.canvas.addEventListener('wheel',e=>{e.preventDefault();this.zoom(e.deltaY>0?1.15:1/1.15,e.offsetX);},{passive:false});
  this.canvas.addEventListener('pointerdown',e=>{this.canvas.setPointerCapture(e.pointerId);this.pointer={x:e.offsetX,right:this.right};this.canvas.style.cursor='grabbing';});
  this.canvas.addEventListener('pointermove',e=>{if(this.pointer){this.follow=false;this.right=Math.max(2,Math.min(this.data.length+8,this.pointer.right-(e.offsetX-this.pointer.x)/Math.max(1,this.plotWidth/this.count)));}this.hover={x:e.offsetX,y:e.offsetY};this.draw();});
  const release=()=>{this.pointer=null;this.canvas.style.cursor='crosshair';};
  this.canvas.addEventListener('pointerup',release);this.canvas.addEventListener('pointercancel',release);
  this.canvas.addEventListener('pointerleave',()=>{if(!this.pointer){this.hover=null;this.draw();}});
  this.canvas.addEventListener('keydown',e=>{if(['+','=','-','ArrowLeft','ArrowRight','End'].includes(e.key))e.preventDefault();if(e.key==='+'||e.key==='=')this.zoom(.85);else if(e.key==='-')this.zoom(1.15);else if(e.key==='End')this.live();else if(e.key==='ArrowLeft'||e.key==='ArrowRight'){this.follow=false;this.right=Math.max(2,Math.min(this.data.length+8,this.right+(e.key==='ArrowLeft'?-4:4)));this.draw();}});
  document.fonts.ready.then(()=>this.draw());
 }
 resize(){const rect=this.canvas.parentElement.getBoundingClientRect();this.width=rect.width;this.height=rect.height;const dpr=window.devicePixelRatio||1;this.canvas.width=Math.round(rect.width*dpr);this.canvas.height=Math.round(rect.height*dpr);this.canvas.style.width=rect.width+'px';this.canvas.style.height=rect.height+'px';this.ctx.setTransform(dpr,0,0,dpr,0,0);this.ctx.imageSmoothingEnabled=false;this.draw();}
 setData(rows){const old=this.data.length,last=this.data.at(-1)?.time;this.data=rows;if(this.follow||!old)this.right=rows.length+3;else{const offset=rows.findIndex(b=>b.time===last)-(old-1);if(offset!==-old)this.right+=offset;}this.draw();}
 zoom(factor,x=this.plotWidth/2){const previous=this.count;this.count=Math.max(8,Math.min(168,this.count*factor));if(!this.follow)this.right+=(this.count-previous)*(1-Math.max(0,Math.min(1,x/this.plotWidth)));this.draw();}
 live(){this.follow=true;this.right=this.data.length+3;this.hover=null;this.draw();}
 today(){const start=Date.parse(new Date().toISOString().slice(0,10)+'T00:00:00Z')/1000;const first=this.data.findIndex(b=>b.time>=start);if(first>=0){this.follow=true;this.count=Math.max(8,this.data.length-first+4);this.right=this.data.length+3;this.draw();}}
 draw(){if(!this.frame)this.frame=requestAnimationFrame(()=>{this.frame=null;this.paint();});}
 paint(){
  const ctx=this.ctx,w=this.width,h=this.height;if(!w||!h)return;
  ctx.clearRect(0,0,w,h);
  const left=8,right=w-(w<500?86:104),top=22,bottom=h-36,priceBottom=bottom-70;
  this.plotWidth=right-left;const step=this.plotWidth/this.count,first=this.right-this.count;
  const visible=this.data.filter((_,i)=>i>=Math.floor(first)&&i<=Math.ceil(this.right));
  if(!visible.length){ctx.fillStyle=MUTED;ctx.font='11px monospace';ctx.fillText('WAITING FOR MARKET HISTORY...',18,h/2);return;}
  let min=Math.min(...visible.map(b=>b.low)),max=Math.max(...visible.map(b=>b.high));
  // Include strategy levels when following live; old historical pans keep their own scale.
  if(this.follow){if(grid&&fibVisible){min=Math.min(min,grid.low);max=Math.max(max,grid.high);}if(position){for(const p of [position.stop,position.target])if(Number.isFinite(p)){min=Math.min(min,p);max=Math.max(max,p);}}}
  const span=Math.max(max-min,max*.0002);min-=span*.08;max+=span*.08;
  const y=price=>top+(max-price)/(max-min)*(priceBottom-top);
  const x=i=>left+(i-first+.5)*step;
  ctx.font='10px monospace';ctx.textBaseline='middle';
  for(let i=0;i<=5;i++){const py=Math.round(top+i*(priceBottom-top)/5)+.5;ctx.strokeStyle='#292719';ctx.setLineDash([2,6]);ctx.beginPath();ctx.moveTo(left,py);ctx.lineTo(right,py);ctx.stroke();ctx.fillStyle=MUTED;ctx.fillText(money(max-i*(max-min)/5),right+9,py);}
  ctx.setLineDash([]);
  const interval=Math.max(1,Math.ceil(this.count/6),Math.ceil(78/step));
  for(let i=Math.max(0,Math.ceil(first));i<this.data.length&&i<this.right;i++)if(i%interval===0){const px=Math.round(x(i))+.5;ctx.strokeStyle='#242319';ctx.setLineDash([2,6]);ctx.beginPath();ctx.moveTo(px,top);ctx.lineTo(px,bottom);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=MUTED;const d=new Date(this.data[i].time*1000);ctx.fillText(`${d.getUTCDate().toString().padStart(2,'0')} / ${d.getUTCHours().toString().padStart(2,'0')}:00`,Math.max(left,px-25),h-14);}
  ctx.save();ctx.beginPath();ctx.rect(left,top,right-left,bottom-top);ctx.clip();
  if(grid&&fibVisible){
   const zone=grid.levels.find(l=>l.ratio===.618).price;
   const a=y(zone),b=y(grid.start);ctx.fillStyle='#f0b90b0a';ctx.fillRect(left,Math.min(a,b),right-left,Math.abs(a-b));
   for(const level of grid.levels){const py=Math.round(y(level.price))+.5;if(py<top||py>priceBottom)continue;ctx.strokeStyle=level.ratio===.618?GOLD:'#9b8241';ctx.setLineDash([5,5]);ctx.beginPath();ctx.moveTo(left,py);ctx.lineTo(right,py);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=GOLD;ctx.font='9px RiggedPixel,monospace';ctx.textAlign='right';ctx.fillText(`${(level.ratio*100).toFixed(1)}%`,right-5,py-7);ctx.textAlign='left';}
   const aIndex=this.data.findIndex(b=>b.time===grid.start_time/1000),bIndex=this.data.findIndex(b=>b.time===grid.end_time/1000);
   if(aIndex>=0&&bIndex>=0){ctx.strokeStyle=GOLD;ctx.setLineDash([4,4]);ctx.beginPath();ctx.moveTo(x(aIndex),y(grid.start));ctx.lineTo(x(bIndex),y(grid.end));ctx.stroke();ctx.setLineDash([]);for(const [ix,price]of [[aIndex,grid.start],[bIndex,grid.end]]){ctx.fillStyle=GOLD;ctx.fillRect(Math.round(x(ix))-3,Math.round(y(price))-3,6,6);}}
  }
  const maxVolume=Math.max(...visible.map(b=>b.volume),1);
  for(let i=Math.max(0,Math.floor(first));i<this.data.length&&i<this.right;i++){
   const b=this.data[i],px=Math.round(x(i)),bodyWidth=Math.max(2,Math.floor(step*.58)),color=b.close>=b.open?UP:DOWN;
   ctx.strokeStyle=color;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(px+.5,Math.round(y(b.high)));ctx.lineTo(px+.5,Math.round(y(b.low)));ctx.stroke();
   ctx.fillStyle=color;ctx.fillRect(px-Math.floor(bodyWidth/2),Math.round(Math.min(y(b.open),y(b.close))),bodyWidth,Math.max(2,Math.round(Math.abs(y(b.open)-y(b.close)))));
   const vh=b.volume/maxVolume*54;ctx.fillStyle=b.close>=b.open?'#e5c66338':'#d9776838';ctx.fillRect(px-Math.floor(bodyWidth/2),bottom-vh,bodyWidth,vh);
  }
  if(position)for(const [key,color]of [['entry','#dfdac6'],['target',UP],['stop',DOWN]])if(Number.isFinite(position[key])){const py=y(position[key]);ctx.strokeStyle=color;ctx.setLineDash([8,3]);ctx.beginPath();ctx.moveTo(left,py);ctx.lineTo(right,py);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=color;ctx.font='9px RiggedPixel,monospace';ctx.fillText(key.toUpperCase(),left+5,py-8);}
  ctx.restore();
  const last=this.data.at(-1);if(last){const py=Math.max(top,Math.min(priceBottom,y(currentPrice??last.close)));ctx.fillStyle=GOLD;ctx.fillRect(right+2,py-10,w-right-3,20);ctx.fillStyle='#11100b';ctx.font='bold 10px monospace';ctx.fillText(money(currentPrice??last.close),right+7,py);}
  ctx.fillStyle='#55513e';ctx.font='9px RiggedPixel,monospace';ctx.fillText('VOL',left+5,bottom-60);
  if(this.hover&&this.hover.x<=right&&this.hover.y>=top&&this.hover.y<=priceBottom){
   const index=Math.round(first+(this.hover.x-left)/step-.5),b=this.data[index];
   if(b){const px=x(index),py=this.hover.y;ctx.strokeStyle='#b1a779';ctx.setLineDash([3,4]);ctx.beginPath();ctx.moveTo(px,top);ctx.lineTo(px,bottom);ctx.moveTo(left,py);ctx.lineTo(right,py);ctx.stroke();ctx.setLineDash([]);ohlc(b);const price=max-(py-top)/(priceBottom-top)*(max-min);ctx.fillStyle='#302c19';ctx.fillRect(right+2,py-10,w-right-3,20);ctx.fillStyle='#e9dba5';ctx.font='10px monospace';ctx.fillText(money(price),right+7,py);}
  }
 }
}
const chart=new PixelChart($('market-chart'));
function setPrice(price,source){if(!Number.isFinite(price)||price<=0)return;const prior=currentPrice;currentPrice=price;$('price').textContent='$'+money(price);$('price').classList.toggle('positive',prior!==null&&price>prior);$('price').classList.toggle('negative',prior!==null&&price<prior);$('price-source').textContent=source;chart.draw();}
function historyView(){const rows=[...candleMap.values()].sort((a,b)=>a.time-b.time);chart.setData(rows);if(!chart.hover)ohlc(rows.at(-1));}
function renderFib(state=window.RIGGED_STATE){
 grid=state?(state.position?.fib??state.fib??null):buildFibonacci(bars,new Date().toISOString().slice(0,10),Date.now());position=state?.position??null;
 $('fib-levels').replaceChildren();
 if(!grid){$('fib-direction').textContent='No unambiguous completed-hour swing';$('fib-anchors').textContent='Waiting for the daily low and high to occur in distinct completed hourly candles.';}
 else{
  $('fib-direction').textContent=`${grid.direction==='up'?'Upward':'Downward'} swing · ${position?.fib?'locked for open trade':'confirmed hourly anchors'}`;
  $('fib-anchors').textContent=`${money(grid.start)} (${utc(grid.start_time)}) → ${money(grid.end)} (${utc(grid.end_time)})`;
  for(const level of grid.levels){const chip=document.createElement('span');chip.textContent=`${(level.ratio*100).toFixed(1)}% · ${money(level.price)}`;$('fib-levels').append(chip);}
 }
 $('fib-exits').textContent=position?`Open ${position.side} · entry ${money(position.entry)}${position.stop?` · stop ${money(position.stop)} · next target ${money(position.target)}`:''} · anchors held fixed`:'Entry: range extreme · exits: 25% at each of three Fib targets, then trail the remainder · one position at a time';
 chart.draw();
}
async function loadHistory(){
 const c=window.RIGGED_CONFIG;
 try{
  const r=await fetch(`${c.supabaseUrl}/rest/v1/rigged_candles?select=*&order=time.desc&limit=168`,{headers:{apikey:c.publishableKey},signal:AbortSignal.timeout(12000),cache:'no-store'});
  if(!r.ok)throw Error(`Market history returned ${r.status}`);
  const saved=(await r.json()).reverse();bars=saved.map(b=>({...b,time:Number(b.time)}));
  for(const b of saved){const t=Number(b.time)/1000;if(t*1000>=lastKline&&Date.now()-lastMessage<15000)continue;candleMap.set(t,{time:t,open:Number(b.open),high:Number(b.high),low:Number(b.low),close:Number(b.close),volume:Number(b.volume)});}
  const times=[...candleMap.keys()].sort((a,b)=>a-b);for(const t of times.slice(0,-168))candleMap.delete(t);
  historyView();renderFib();
  if(!saved.length)$('market-message').textContent='Waiting for the first hourly history snapshot. The stream can still update the forming candle.';
  if(saved.length&&Date.now()-lastMessage>=15000){const age=Date.now()-Date.parse(saved.at(-1).updated_at);$('market-status').textContent=age<180000?'MINUTE SNAPSHOT':'DATA STALE';$('market-message').textContent=age<180000?'Stream unavailable. Showing CCXT hourly candles saved by Supabase each minute.':'Stream and saved data are behind; displayed prices are historical.';setPrice(Number(saved.at(-1).close),`Supabase snapshot · ${new Date(saved.at(-1).updated_at).toLocaleTimeString()}`);}
 }catch(e){if(Date.now()-lastMessage>=15000)$('market-message').textContent=`Cannot load history: ${e.message}. Keeping the last visible candles.`;}
 finally{setTimeout(loadHistory,15000);}
}
function connect(){
 clearTimeout(retryTimer);socket=new WebSocket('wss://fstream.binance.com/market/stream?streams=btcusdt@kline_1h/btcusdt@aggTrade/btcusdt@markPrice@1s');
 socket.onmessage=e=>{
  let data;try{data=JSON.parse(e.data).data;}catch{return;}
  if(!data||data.s!=='BTCUSDT'||!Number.isFinite(Number(data.E))||Math.abs(Date.now()-Number(data.E))>15000)return;
  lastMessage=Date.now();backoff=1000;$('market-status').textContent='LIVE STREAM';$('market-status').classList.add('positive');
  $('market-message').textContent='Live Binance futures / UTC · drag to pan · scroll or +/- to zoom · arrows to pan · End to follow';
  if(data.e==='aggTrade'){lastTick=Date.now();window.RIGGED_MARKET_LIVE=true;setPrice(Number(data.p),'Binance futures · live trade price');}
  else if(data.e==='markPriceUpdate')$('market-status').title=`Mark price ${money(data.p)} · ${new Date().toLocaleTimeString()}`;
  else if(data.e==='kline'&&data.k.i==='1h'){
   const k=data.k,b={time:Number(k.t)/1000,open:Number(k.o),high:Number(k.h),low:Number(k.l),close:Number(k.c),volume:Number(k.v)};
   if(![b.time,b.open,b.high,b.low,b.close,b.volume].every(Number.isFinite)||b.low<=0||b.low>b.high||b.time*1000<lastKline)return;
   lastKline=b.time*1000;candleMap.set(b.time,b);historyView();
   if(Date.now()-lastTick>5000){lastTick=Date.now();window.RIGGED_MARKET_LIVE=true;setPrice(b.close,'Binance futures · live candle price');}
  }
 };
 socket.onerror=()=>socket.close();socket.onclose=()=>{window.RIGGED_MARKET_LIVE=false;$('market-status').classList.remove('positive');$('market-status').textContent='RECONNECTING';retryTimer=setTimeout(connect,backoff);backoff=Math.min(backoff*2,30000);};
}
$('fib-toggle').onclick=()=>{fibVisible=!fibVisible;$('fib-toggle').setAttribute('aria-pressed',String(fibVisible));$('fib-toggle').textContent=fibVisible?'FIB ON':'FIB OFF';chart.draw();};
$('chart-today').onclick=()=>chart.today();$('chart-live').onclick=()=>chart.live();
$('chart-fullscreen').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.querySelector('.market-panel').requestFullscreen();}catch{$('market-message').textContent='Fullscreen unavailable; chart controls remain available.';}};
window.addEventListener('rigged-state',e=>renderFib(e.detail));
setInterval(()=>{if(Date.now()-lastTick>15000)window.RIGGED_MARKET_LIVE=false;if(Date.now()-lastMessage>20000&&socket?.readyState===WebSocket.OPEN){$('market-status').textContent='STREAM STALE';socket.close();}},5000);
loadHistory();connect();
