import {GAME,remainingHands} from './game-rules.mjs';
import {riverTransition,discardRequest} from './river-events.mjs';
import {drawTransition} from './draw-events.mjs';
import {callEvent} from './meld-events.mjs';
const same=(a,b)=>[...a].sort().join(' ')===[...b].sort().join(' ');
// A frame transition becomes requests only when every intervening event is
// accounted for. Ambiguous animations stay pending; no guessed actions.
export function publicEvents(before,after,seats,call=null){
  const fail=reason=>({verified:false,reason,requests:[]});
  // A call removes the source discard rather than extending its river.
  // Route the complete transaction before the ordinary river comparator.
  if(call){
    if(GAME.positions.some(p=>before.round?.seat_identity?.seats?.[p]!==seats[p]))return fail('call_seat_mismatch');
    return callEvent(before,after,call);
  }
  if(!before.hand?.complete||!after.hand?.complete)return fail('hand_incomplete');
  const a=before.round,b=after.round;
  if(a.wind!==b.wind||a.hand_number.value!==b.hand_number.value||a.counters.honba!==b.counters.honba)
    return fail('round_transition');
  const delta=a.remaining.value-b.remaining.value;
  if(!Number.isInteger(a.remaining.value)||!Number.isInteger(b.remaining.value)||![0,1].includes(delta))
    return fail('unaccounted_draws');
  const river=riverTransition(before,after);
  if(!river.verified)return fail(river.reason);
  if(!Number.isInteger(a.counters.riichi_sticks)||!Number.isInteger(b.counters.riichi_sticks))return fail('unknown_deposits');
  const deposits=b.counters.riichi_sticks-a.counters.riichi_sticks;
  if(!Number.isInteger(deposits)||![0,1].includes(deposits))return fail('unaccounted_deposits');
  if(river.kind==='unchanged'){
    if(deposits)return fail('declaration_without_discard');
    if(delta===0)return same(before.hand.tiles.map(t=>t.tile),after.hand.tiles.map(t=>t.tile))
      ?{verified:true,requests:[]}:fail('hand_changed_without_event');
    const draw=drawTransition(before,after,seats);
    return draw.verified?{verified:true,requests:[draw.request]}:fail(draw.reason);
  }
  const added=river.additions[0];
  if(added.position==='self')return fail('own_discard_requires_pending_decision_or_explicit_recovery');
  if(!same(before.hand.tiles.map(t=>t.tile),after.hand.tiles.map(t=>t.tile)))return fail('hand_changed_during_other_discard');
  const tile=after.rivers[added.position].tiles.at(-1);
  if(typeof tile.sideways!=='boolean')return fail('discard_orientation_unknown');
  if(tile.sideways!==!!deposits)return fail('riichi_acceptance_not_yet_verified');
  const seat=seats[added.position];
  if(delta===0&&before.round.turn.position!==added.position)return fail('discard_actor_not_previously_drawing');
  const requests=delta===1?[{state:`3 ${seat} DRAW`,validact:null}]:[];
  requests.push(discardRequest(river,seats,!!deposits));
  return {verified:true,requests,acceptedRiichi:deposits?{seat,eventId:`${after.id}:${seat}:riichi`,confirmed:true}:null};
}
