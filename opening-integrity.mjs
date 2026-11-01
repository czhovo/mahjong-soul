// Do not commit a transient dealing/sorting frame as a new hand.
export function assertOpeningIntegrity(frame){
 const positions=['self','right','opposite','left'];
 if(!positions.every(p=>frame.rivers?.[p]?.tiles?.length===0))return;
 if(positions.some(p=>(p==='self'?frame.own_melds:frame.opponent_melds?.[p])?.groups?.length))return;
 const tiles=frame.hand?.tiles??[],xs=tiles.map(t=>t.center?.[0]);
 if(xs.length>=13&&xs.every(Number.isFinite)){
  const gaps=xs.slice(1).map((x,i)=>x-xs[i]);
  const sorted=[...gaps].sort((a,b)=>a-b),pitch=sorted[Math.floor(sorted.length/2)];
  // The final separated draw is legitimate; a hole inside the rack is not.
  if(pitch>0&&gaps.slice(0,-1).some(g=>g>pitch*1.55))throw Error('Opening hand still sorting or missing an interior tile');
 }
 if(frame.round?.seat_identity?.seats?.self===0&&frame.round?.remaining?.value===69&&tiles.length===13)
  throw Error('Dealer opening draw not fully visible');
}
