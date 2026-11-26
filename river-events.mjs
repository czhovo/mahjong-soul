import {GAME,remainingHands} from './game-rules.mjs';
// Compare complete visible rivers. Never invent ordering for missed frames.
export function riverTransition(before,after){
  const additions=[];
  for(const position of GAME.positions){
    const a=before.rivers?.[position],b=after.rivers?.[position];
    if(!a?.complete||!b?.complete)return {verified:false,reason:'incomplete_frame'};
    const old=a.tiles.map(t=>t.tile),next=b.tiles.map(t=>t.tile);
    if(next.length<old.length||old.some((t,i)=>t!==next[i]))
      return {verified:false,reason:'river_changed_requires_call_or_round_evidence'};
    for(let i=old.length;i<next.length;i++)additions.push({position,index:i,tile:next[i]});
  }
  if(additions.length>1)return {verified:false,reason:'multiple_discards_order_unknown',additions};
  return {verified:true,kind:additions.length?'discard':'unchanged',additions,
    beforeId:before.id,afterId:after.id};
}

export function discardRequest(transition,seats,acceptedRiichi){
  if(!transition.verified||transition.kind!=='discard'||typeof acceptedRiichi!=='boolean')
    throw Error('Single verified discard and explicit riichi status required');
  const hit=transition.additions[0],seat=seats[hit.position];
  if(!Number.isInteger(seat)||seat<0||seat>=GAME.players)throw Error('Verified seat identity required');
  return {state:`3 ${seat} ${acceptedRiichi?'LIZHI':'PLAY'} ${hit.tile}`,validact:null};
}
