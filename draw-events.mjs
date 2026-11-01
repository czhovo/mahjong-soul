import {riverTransition} from './river-events.mjs';

export function drawTransition(before,after,seats){
  const rivers=riverTransition(before,after);
  if(!rivers.verified||rivers.kind!=='unchanged')return {verified:false,reason:'draw_requires_unchanged_complete_rivers'};
  const old=before.round?.remaining?.value,next=after.round?.remaining?.value;
  if(!Number.isInteger(old)||!Number.isInteger(next)||old-next!==1)
    return {verified:false,reason:'single_wall_decrement_required'};
  const position=after.round?.turn?.position,seat=seats?.[position];
  if(!Number.isInteger(seat)||seat<0||seat>3)return {verified:false,reason:'draw_actor_unknown'};
  if(!before.hand?.complete||!after.hand?.complete)return {verified:false,reason:'hand_incomplete'};
  const previous=before.hand.tiles.map(t=>t.tile),current=after.hand.tiles.map(t=>t.tile);
  const remaining=[...current];
  for(const tile of previous){const i=remaining.indexOf(tile);if(i<0)return {verified:false,reason:'hand_changed_unexpectedly'};remaining.splice(i,1);}
  if(position==='self'&&remaining.length!==1)return {verified:false,reason:'single_drawn_tile_required'};
  if(position!=='self'&&remaining.length!==0)return {verified:false,reason:'own_hand_changed_during_other_draw'};
  return {verified:true,position,request:{state:position==='self'?`2 ${remaining[0]}`:`3 ${seat} DRAW`,validact:null},
    beforeId:before.id,afterId:after.id};
}
