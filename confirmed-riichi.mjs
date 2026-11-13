export function declaredSeats(requests=[]){
 return new Set(requests.flatMap(r=>{const m=/^3 ([0-3]) LIZHI /.exec(r.state??'');return m?[Number(m[1])]:[];}));
}

// Keep sideways geometry on the recognition frame. Only the first sideways
// discard by each player in this hand is a declaration in the event stream.
export function riichiEvents(events,history=[]){
 const seen=declaredSeats(history);
 return events.map(e=>{
  if(e.state?.startsWith('0 '))seen.clear();
  const m=/^3 ([0-3]) LIZHI (\S+)$/.exec(e.state??'');
  if(!m)return e;
  if(seen.has(+m[1]))return {...e,state:`3 ${m[1]} PLAY ${m[2]}`};
  seen.add(+m[1]);return e;
 });
}

// Same-round replacement may change inferred chronology, never erase a
// confirmed declaration. Refuse an unlocatable declaration instead of guessing.
export function preserveRiichi(history,next){
 const declarations=new Map();
 for(const r of history??[]){const m=/^3 ([0-3]) LIZHI ([WBTZ][0-9])$/.exec(r.state??'');if(m&&!declarations.has(m[1]))declarations.set(m[1],m[2]);}
 const out=structuredClone(next);
 for(const [seat,tile] of declarations){
  for(const e of out)if(e.state?.startsWith(`3 ${seat} LIZHI `)&&e.state!==`3 ${seat} LIZHI ${tile}`)e.state=e.state.replace(' LIZHI ',' PLAY ');
  if(out.some(r=>r.state===`3 ${seat} LIZHI ${tile}`))continue;
  const hits=out.filter(r=>r.state===`3 ${seat} PLAY ${tile}`);
  if(hits.length!==1)throw Object.assign(Error('无法定位已确认立直的宣言牌；保留原历史'),{code:'RIICHI_STATE_LOSS'});
  hits[0].state=`3 ${seat} LIZHI ${tile}`;
 }
 return riichiEvents(out);
}
