// Shared by live play and post-match polling so changing adapters cannot repeat it.
let last=null;
export function reportMatchResult(frame,emit){
 const r=frame.result_page;
 if(r?.kind!=='match-result'){
  if(frame.hand?.complete&&frame.round?.seat_identity?.verified)last=null;
  return false;
 }
 if(!r.complete||r.archivePending)return false;
 // Saved result pages report their fields and filename together.
 if(r.screenshot)return false;
 const key=JSON.stringify([r.name,r.rank,r.points,r.ptChange]);
 if(key===last)return false;
 last=key;
 emit(`终局结果：第${r.rank}名；${r.points}点；积分${r.ptChange>=0?'+':''}${r.ptChange}`);
 return true;
}
