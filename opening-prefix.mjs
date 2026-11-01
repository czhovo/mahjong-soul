import {roundIdentity} from './round-boundary.mjs';
import {assertOpeningIntegrity} from './opening-integrity.mjs';
function missedOpening(message){return Object.assign(new Error(message),{code:'OPENING_PASSED'});}
// Reconstruct only the first clockwise sequence of visible discards. No
// opponent hand contents, calls, or earlier own draws can be inferred here.
export function openingPrefix(frame,{allowPending=false}={}){
 assertOpeningIntegrity(frame);
 const r=roundIdentity(frame),hand=frame.hand?.tiles?.map(t=>t.tile);
 if(!r||!frame.hand.complete||![13,14].includes(hand.length)||!frame.dora?.complete||frame.dora.tiles.length!==1)throw Error('Incomplete opening');
 const requests=[],rivers={};let ended=false,count=0;
 for(let seat=0;seat<4;seat++){
  const p=Object.keys(r.seats).find(p=>r.seats[p]===seat);
  const river=frame.rivers?.[p],meld=p==='self'?frame.own_melds:frame.opponent_melds?.[p];
  if(!river?.complete||!meld?.complete)throw Error('Opening prefix incomplete');
  if(meld.groups.length||river.tiles.length>1||river.tiles.some(t=>t.sideways))throw missedOpening('Opening already contains calls or later discards');
  rivers[p]=river.tiles.map(t=>t.tile);
  if(seat>=r.seats.self&&river.tiles.length)throw missedOpening('Own first turn already passed');
  if(!river.tiles.length){ended=true;continue;}
  if(ended)throw Error('Opening discard order gap');
  requests.push({state:`3 ${seat} DRAW`,validact:null},{state:`3 ${seat} PLAY ${river.tiles[0].tile}`,validact:null});count++;
 }
 const own=hand.length===14;
 if(own){
  if(count!==r.seats.self||frame.round.remaining?.value!==69-count||frame.controls?.PASS)throw Error('Not an own first draw');
  requests.push({state:`2 ${hand.at(-1)}`,validact:null});
 }else if(!count||!frame.controls?.PASS||frame.round.remaining?.value!==70-count){
  // A freshly dealt 13-tile hand may be waiting for the dealer/earlier seats.
  // It is a valid starting observation, but never an actionable bot request.
  const remaining=frame.round.remaining?.value;
  if(!allowPending||frame.controls?.PASS||!Number.isInteger(remaining)||![70-count,69-count].includes(remaining))throw Error('Not an opening reaction');
 }
 return {verified:true,requests,hand:hand.slice(0,13),draw:own?hand.at(-1):null,
  wind:r.wind,seats:r.seats,rivers,indicator:frame.dora.tiles[0].tile,round:r};
}
