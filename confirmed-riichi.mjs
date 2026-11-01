export function declaredSeats(requests=[]){
 return new Set(requests.flatMap(r=>{const m=/^3 ([0-3]) LIZHI /.exec(r.state??'');return m?[Number(m[1])]:[];}));
}

// Same-round replacement may change inferred chronology, never erase a
// confirmed declaration. Refuse an unlocatable declaration instead of guessing.
export function preserveRiichi(history,next){
 const declarations=new Map();
 for(const r of history??[]){const m=/^3 ([0-3]) LIZHI ([WBTZ][0-9])$/.exec(r.state??'');if(m&&!declarations.has(m[1]))declarations.set(m[1],m[2]);}
 const out=structuredClone(next),present=declaredSeats(out);
 for(const [seat,tile] of declarations){
  if(present.has(Number(seat)))continue;
  const hits=out.filter(r=>r.state===`3 ${seat} PLAY ${tile}`);
  if(hits.length!==1)throw Object.assign(Error('无法定位已确认立直的宣言牌；保留原历史'),{code:'RIICHI_STATE_LOSS'});
  hits[0].state=`3 ${seat} LIZHI ${tile}`;
 }
 return out;
}
