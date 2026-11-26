import {GAME,remainingHands} from './game-rules.mjs';
import {roundIdentity} from './round-boundary.mjs';
import {canonicalMelds} from './meld-events.mjs';
import {CallSequence} from './call-sequence.mjs';

// Once the visible hand and meld prove the call, no other player can act
// before its required discard. Preserve those public values with provenance.
export function postCallAnchor(decision,before,selection){
 const [kind,called]=decision.output.response.split(' ');
 if(!['CHI','PENG'].includes(kind)||!selection.hand?.complete||!selection.own_melds?.complete)throw Error('Confirmed call selection required');
 const a=roundIdentity(before),b=roundIdentity(selection);
 if(!a||!b||JSON.stringify(a)!==JSON.stringify(b))throw Error('Call round identity changed');
 if(before.round.counters.honba!==selection.round.counters.honba)throw Error('Public counters changed during call');
 const source=decision.ledger.lastPlayer;
 if(source===a.seats.self||decision.ledger.lastDiscard!==called)throw Error('Call source not verified');
 const oldMelds=canonicalMelds(before,'self',before.own_melds),newMelds=canonicalMelds(selection,'self',selection.own_melds);
 const sequence=new CallSequence(decision.output.response,{verified:true,hand:decision.visibleHand,melds:oldMelds,allowDeferredDiscard:!!decision.callSearch},source);
 sequence.inputSent();sequence.verifyMeld({verified:true,hand:selection.hand.tiles.map(t=>t.tile),melds:newMelds});
 const rivers=structuredClone(before.rivers);
 // The verified meld and remaining hand authorize the mandatory discard.
 // Missing unrelated river history remains incomplete, not a reason to block it.
 for(const position of GAME.positions)rivers[position]??={complete:false,tiles:[]};
 const position=Object.keys(a.seats).find(p=>a.seats[p]===source);
 const sourceVisible=rivers[position].tiles.at(-1)?.tile===called;
 // The exact current hand and new meld above prove the call. An obsolete
 // source river cannot veto its mandatory discard or be projected as complete.
 if(!sourceVisible)rivers[position]={complete:false,tiles:[],projectionConflict:true};
 const deposit=selection.round.counters.riichi_sticks-before.round.counters.riichi_sticks;
 let acceptedRiichi;
 if(deposit!==0){
  const request=decision.input?.requests?.at(-1)?.state;
  if(deposit===1&&rivers[position].tiles.at(-1)?.sideways&&request===`3 ${source} LIZHI ${called}`)
   acceptedRiichi={eventId:`called-riichi:${before.id}:${source}`,seat:source,confirmed:true};
 }
 if(sourceVisible)rivers[position].tiles.pop();
 // Face boxes belong to the old image; do not use these projected regions
 // as fresh geometric tracking sources.
 for(const r of Object.values(rivers)){delete r.face_boxes;delete r.face_count;r.projected=true;}
 return {...selection,rivers,dora:structuredClone(before.dora),opponent_melds:structuredClone(before.opponent_melds),
  acceptedRiichi,publicProjection:{source:before.id,reason:'visually verified call before mandatory own discard',called,sourceSeat:source}};
}
