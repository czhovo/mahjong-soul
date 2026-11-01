import {validateMeld} from './meld-state.mjs';
const same=(a,b)=>[...a].sort().join(' ')===[...b].sort().join(' ');
const equal=(a,b)=>a.kind===b.kind&&a.from===b.from&&a.calledIndex===b.calledIndex&&same(a.tiles,b.tiles);
const positions=['self','right','opposite','left'];

export function canonicalMelds(frame,position,observation){
  if(!observation?.complete||!frame.round?.seat_identity?.verified)throw Error('Incomplete meld or seat observation');
  const owner=positions.indexOf(position),seats=frame.round.seat_identity.seats;
  if(owner<0)throw Error('Unknown owner');
  return observation.groups.map(g=>{
    const offset={left:3,opposite:2,right:1}[g.fromRelative];
    const from=g.kind==='ANGANG'?null:seats[positions[(owner+offset)%4]];
    return validateMeld({kind:g.kind,tiles:g.tiles,calledIndex:g.calledIndex,from});
  });
}

// Only a completely accounted-for chi/pung plus its discard becomes a request.
// The source tile was already recorded by the caller's public-event ledger.
export function callEvent(before,after,{actor,lastDiscard,oldMelds,newMelds}){
  const fail=reason=>({verified:false,reason,requests:[]});
  if(!before.round?.seat_identity?.verified||!after.round?.seat_identity?.verified)return fail('seats_unknown');
  const seats=before.round.seat_identity.seats;
  if(JSON.stringify(seats)!==JSON.stringify(after.round.seat_identity.seats))return fail('seats_changed');
  if(!positions.includes(actor)||!lastDiscard||!Number.isInteger(lastDiscard.seat))return fail('last_discard_unknown');
  const a=before.round,b=after.round;
  if(a.wind!==b.wind||a.hand_number.value!==b.hand_number.value||a.counters.honba!==b.counters.honba||a.counters.riichi_sticks!==b.counters.riichi_sticks)return fail('round_or_declaration_changed');
  if(!Number.isInteger(a.remaining.value)||a.remaining.value!==b.remaining.value)return fail('intervening_draw');
  const rest=newMelds.map(validateMeld);
  for(const old of oldMelds.map(validateMeld)){
    const index=rest.findIndex(m=>equal(m,old));
    if(index<0)return fail('old_meld_changed');rest.splice(index,1);
  }
  if(rest.length!==1||!['CHI','PENG'].includes(rest[0].kind))return fail('single_chi_or_pung_required');
  const meld=rest[0],called=meld.tiles[meld.calledIndex];
  if(meld.from!==lastDiscard.seat||called!==lastDiscard.tile||meld.from===seats[actor])return fail('call_source_mismatch');
  if(meld.kind==='CHI'&&(seats[actor]+3)%4!==meld.from)return fail('chi_source_not_left');
  let discard;
  for(const p of positions){
    const old=before.rivers[p],next=after.rivers[p];
    if(!old?.complete||!next?.complete)return fail('incomplete_river');
    const expected=old.tiles.map(t=>t.tile);
    if(seats[p]===meld.from){if(expected.pop()!==called)return fail('source_tile_not_last');}
    if(p===actor){discard=next.tiles.at(-1)?.tile;if(!discard)return fail('call_discard_missing');expected.push(discard);}
    if(expected.join(' ')!==next.tiles.map(t=>t.tile).join(' '))return fail('unaccounted_river_change');
  }
  if(!before.hand?.complete||!after.hand?.complete)return fail('hand_incomplete');
  const hand=before.hand.tiles.map(t=>t.tile);
  if(actor==='self'){
    const consumed=[...meld.tiles];consumed.splice(meld.calledIndex,1);consumed.push(discard);
    for(const tile of consumed){const i=hand.indexOf(tile);if(i<0)return fail('consumed_tile_missing');hand.splice(i,1);}
  }
  if(!same(hand,after.hand.tiles.map(t=>t.tile)))return fail('unaccounted_hand_change');
  const own=[...meld.tiles];own.splice(meld.calledIndex,1);
  return {verified:true,requests:[{state:`3 ${seats[actor]} ${meld.kind} ${called} ${own.join(' ')} ${discard}`,validact:null}],beforeId:before.id,afterId:after.id};
}
