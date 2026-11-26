import {GAME,remainingHands} from './game-rules.mjs';

function tileSortRank(tile){
 const m=/^([WBTZ])([0-9])$/.exec(tile??'');
 return m?'WBTZ'.indexOf(m[1])*10+(Number(m[2])||5):NaN;
}
export function isConcealedHandSorted(tiles){
 if(!Array.isArray(tiles)||tiles.length<2)return true;
 for(let i=1;i<tiles.length;i++){
  const prev=tileSortRank(typeof tiles[i-1]==='string'?tiles[i-1]:tiles[i-1]?.tile);
  const cur=tileSortRank(typeof tiles[i]==='string'?tiles[i]:tiles[i]?.tile);
  if(!Number.isFinite(prev)||!Number.isFinite(cur)||cur<prev)return false;
 }
 return true;
}

// Do not commit a transient dealing/sorting frame as a new hand.
export function assertOpeningIntegrity(frame){
 const positions=GAME.positions;
 const tiles=frame.hand?.tiles??[];
 if(!frame.rivers?.self?.tiles?.length&&!frame.own_melds?.groups?.length&&
    tiles.length>=13&&!isConcealedHandSorted(tiles.slice(0,13))){
  throw Error('Opening hand still sorting or missing an interior tile');
 }
 if(!positions.every(p=>frame.rivers?.[p]?.tiles?.length===0))return;
 if(positions.some(p=>(p==='self'?frame.own_melds:frame.opponent_melds?.[p])?.groups?.length))return;
 const xs=tiles.map(t=>t.center?.[0]);
 if(xs.length>=13&&xs.every(Number.isFinite)){
  const gaps=xs.slice(1).map((x,i)=>x-xs[i]);
  const sorted=[...gaps].sort((a,b)=>a-b),pitch=sorted[Math.floor(sorted.length/2)];
  // The final separated draw is legitimate; a hole inside the rack is not.
  if(pitch>0&&gaps.slice(0,-1).some(g=>g>pitch*1.55))throw Error('Opening hand still sorting or missing an interior tile');
 }
 if(frame.round?.seat_identity?.seats?.self===0&&frame.round?.remaining?.value===(GAME.initialWall-1)&&tiles.length===13)
  throw Error('Dealer opening draw not fully visible');
}
