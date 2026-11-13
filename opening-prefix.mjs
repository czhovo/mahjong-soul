import {GAME,remainingHands} from './game-rules.mjs';
import {roundIdentity} from './round-boundary.mjs';
import {assertOpeningIntegrity} from './opening-integrity.mjs';
function missedOpening(message){return Object.assign(new Error(message),{code:'OPENING_PASSED'});}
// Reconstruct only the first clockwise sequence of visible discards. No
// opponent hand contents, calls, or earlier own draws can be inferred here.
export function openingPrefix(frame,{allowPending=false}={}){
 assertOpeningIntegrity(frame);
 const r=roundIdentity(frame),hand=frame.hand?.tiles?.map(t=>t.tile);
 if(!r||!frame.hand.complete||![13,14].includes(hand.length)||!frame.dora?.complete||frame.dora.tiles.length!==1)throw Error('Incomplete opening');
 const requests=[],rivers={},unknownNorth=[];let ended=false,count=0,extractions=0;
 for(let seat=0;seat<GAME.players;seat++){
  const p=Object.keys(r.seats).find(p=>r.seats[p]===seat);
  const river=frame.rivers?.[p],meld=p==='self'?frame.own_melds:frame.opponent_melds?.[p];
  if(!river?.complete||!meld?.complete)throw Error('Opening prefix incomplete');
  if(meld.groups.length||river.tiles.length>1||river.tiles.some(t=>t.sideways))throw missedOpening('Opening already contains calls or later discards');
  rivers[p]=river.tiles.map(t=>t.tile);
  if(seat>=r.seats.self&&river.tiles.length)throw missedOpening('Own first turn already passed');
  const observedKita=GAME.sanma?frame.kita?.[p]?.count:0;
  const knownKita=Number.isInteger(observedKita)&&observedKita>=0&&observedKita<=4;
  if(!knownKita)unknownNorth.push(p);
  const kita=knownKita?observedKita:0;
  if(kita&&seat>=r.seats.self)throw missedOpening('Opening already contains own or later-seat kita');
  if(kita){
   if(ended)throw Error('Opening discard order gap');
   requests.push({state:`3 ${seat} DRAW`,validact:null});
   for(let i=0;i<kita;i++)requests.push({state:`3 ${seat} KITA Z4`,validact:null},{state:`3 ${seat} DRAW`,validact:null});
   extractions+=kita;
  }
  if(!river.tiles.length){ended=true;continue;}
  if(ended)throw Error('Opening discard order gap');
  if(!kita)requests.push({state:`3 ${seat} DRAW`,validact:null});
  requests.push({state:`3 ${seat} PLAY ${river.tiles[0].tile}`,validact:null});count++;
 }
 const own=hand.length===14;
 if(unknownNorth.length){
  // The dealer's initial draw is already out of the wall, including while
  // our hand still has thirteen tiles. Each observed first-cycle discard
  // proves one normal draw; our own first draw proves one more. If the wall
  // balances exactly at this minimum plus known North replacements, none of
  // the unknown regions can contain another extraction. A further consumed
  // tile is ambiguous (next normal draw vs North), so keep it unknown.
  const normalDraws=own?count+1:Math.max(1,count);
  const noUnknownExtraDraws=(!own||count===r.seats.self)&&
   frame.round.remaining?.value===GAME.initialWall-normalDraws-extractions;
  if(!noUnknownExtraDraws)throw Error('Opening kita count incomplete');
  for(const p of unknownNorth)frame.kita[p]={...frame.kita[p],observed_count:frame.kita[p]?.count,
   count:0,count_source:'verified-opening-no-replacement-draws'};
 }
 if(own){
  // Skip is also shown beside own-turn options. The 14-tile hand, first
  // discard sequence and wall count establish the draw; PASS does not.
  if(count!==r.seats.self||frame.round.remaining?.value!==(GAME.initialWall-1)-count-extractions)throw Error('Not an own first draw');
  requests.push({state:`2 ${hand.at(-1)}`,validact:null});
 }else if(!count||!frame.controls?.PASS||frame.round.remaining?.value!==GAME.initialWall-count-extractions){
  // A freshly dealt 13-tile hand may be waiting for the dealer/earlier seats.
  // It is a valid starting observation, but never an actionable bot request.
  const remaining=frame.round.remaining?.value;
  if(!allowPending||frame.controls?.PASS||!Number.isInteger(remaining)||![GAME.initialWall-count-extractions,(GAME.initialWall-1)-count-extractions].includes(remaining))throw Error('Not an opening reaction');
 }
 return {verified:true,requests,hand:hand.slice(0,13),draw:own?hand.at(-1):null,
  wind:r.wind,seats:r.seats,rivers,indicator:frame.dora.tiles[0].tile,round:r};
}
