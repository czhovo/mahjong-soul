import {GAME,remainingHands} from './game-rules.mjs';
// Independent visual evidence; a deposit increase alone cannot identify who paid.
export function ownRiichiAccepted(before,after,tile){
 const old=before.rivers?.self,next=after.rivers?.self;
 if(old?.complete&&next?.complete&&old.tiles.every((t,i)=>t.tile===next.tiles[i]?.tile)&&
    next.tiles[old.tiles.length]?.tile===tile&&next.tiles[old.tiles.length]?.sideways===true)return true;
 const a=before.table_scores,b=after.table_scores;
 if(!a?.complete||!b?.complete||after.round?.counters?.riichi_sticks!==before.round?.counters?.riichi_sticks+1)return false;
 return GAME.positions.every(p=>{
  const x=a.scores?.[p],y=b.scores?.[p];
  return Number.isInteger(x?.value)&&Number.isInteger(y?.value)&&!x.inferred&&!y.inferred&&y.value===x.value-(p==='self'?1000:0);
 });
}
