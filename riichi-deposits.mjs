// Declaration tiles appear before the riichi deposit animation finishes.
// Retain the observed counter; tolerate only payments explained by visible declarations.
export function depositsConsistent(before,after,declarations){
 const a=before.round.counters.riichi_sticks,b=after.round.counters.riichi_sticks;
 if(!Number.isInteger(a)||!Number.isInteger(b)||b<a)return false;
 if(b-a===declarations)return true;
 const visible=f=>Object.values(f.rivers??{}).filter(r=>r.tiles?.some(t=>t.sideways===true)).length;
 const carried=before.round.counters.round_start_riichi_sticks??after.round.counters.round_start_riichi_sticks??0;
 const outstanding=Math.max(0,visible(before)-Math.max(0,a-carried));
 return b-a<=declarations+outstanding;
}
