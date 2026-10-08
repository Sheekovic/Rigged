// Test-only bridge to the actual deployed strategy engine.
import {initialState,step} from '../supabase/functions/rigged-tick/engine.mjs';
let input='';for await(const chunk of process.stdin)input+=chunk;
const rows=JSON.parse(input);let state=initialState(rows[0][0]);const trades=[];
for(const r of rows){
  const result=step(state,r.slice(0,6),[r[0],...r.slice(6,10)],r[10]?[{timestamp:r[0],fundingRate:r[10]}]:[]);
  state=result.state;trades.push(...result.events);
}
process.stdout.write(JSON.stringify({balance:state.balance,equity:state.equity,position:state.position,trades}));
