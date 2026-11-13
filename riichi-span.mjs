import {GAME,remainingHands} from './game-rules.mjs';
import {verifyDiscard} from './discard-verification.mjs';
import {declaredSeats} from './confirmed-riichi.mjs';
import {canonicalMelds} from './meld-events.mjs';

// After accepted riichi, the client may automatically discard draws between
// captures. Recover only a fully visible, call-free ordered sequence.
export function riichiSpan(decision,before,after){
 const declaring=decision.output.response.startsWith('LIZHI ');
 const locked=decision.output.response.startsWith('PLAY ')&&(declaredSeats(decision.input?.requests).has(before.round?.seat_identity?.seats?.self)||before.rivers?.self?.complete&&before.rivers.self.tiles.filter(t=>t.sideways===true).length===1);
 if(!declaring&&!locked)throw Error('Riichi anchor required');
 const a=before.round,b=after.round;
 if(a.wind!==b.wind||a.hand_number.value!==b.hand_number.value||a.counters.honba!==b.counters.honba)throw Error('Unaccounted round');
 if(!a.seat_identity.verified||!b.seat_identity.verified||JSON.stringify(a.seat_identity.seats)!==JSON.stringify(b.seat_identity.seats))throw Error('Changed seats');
 const seats=a.seat_identity.seats,extra={};
 for(const position of GAME.positions){
  if(JSON.stringify(canonicalMelds(before,position,position==='self'?before.own_melds:before.opponent_melds[position]))!==JSON.stringify(canonicalMelds(after,position,position==='self'?after.own_melds:after.opponent_melds[position])))throw Error('Intervening call');
  const old=before.rivers[position],next=after.rivers[position];
  if(!old.complete||!next.complete||old.tiles.some((t,i)=>t.tile!==next.tiles[i]?.tile||t.sideways!==next.tiles[i]?.sideways))throw Error('Incomplete or changed river');
  extra[position]=next.tiles.slice(old.tiles.length);
 }
 const declaration=extra.self.shift();
 if(!declaration||(declaring?!declaration.sideways:(declaration.sideways&&!locked))||declaration.tile!==decision.output.response.split(' ')[1])throw Error('Missing anchor discard');
 let declarations=declaring?1:0;
 for(const [position,tiles] of Object.entries(extra)){
  if(tiles.some(t=>typeof t.sideways!=='boolean'))throw Error('Unknown orientation');
  if(position!=='self'&&!declaredSeats(decision.input?.requests).has(seats[position])&&!before.rivers[position].tiles.some(t=>t.sideways)&&tiles.some(t=>t.sideways))declarations++;
 }
 if(b.counters.riichi_sticks!==a.counters.riichi_sticks+declarations)throw Error('Unaccounted deposits');
 const prefix={...after,rivers:{...after.rivers,self:{...after.rivers.self,tiles:[...before.rivers.self.tiles,declaration]}}};
 const confirmation=verifyDiscard(decision,before,prefix);
 const requests=[],declared=declaredSeats(decision.input?.requests);
 for(const [p,s] of Object.entries(seats))if(p==='self'||before.rivers[p].tiles.some(t=>t.sideways))declared.add(s);
 let offset=1,count=0;
 while(Object.values(extra).some(t=>t.length)){
  const seat=(seats.self+offset)%GAME.players,position=Object.keys(seats).find(p=>seats[p]===seat),tile=extra[position].shift();
  if(!tile)throw Error('Missing intervening discard');
  const fresh=tile.sideways&&!declared.has(seat);if(fresh)declared.add(seat);
  requests.push({state:seat===seats.self?`2 ${tile.tile}`:`3 ${seat} DRAW`,validact:null},{state:`3 ${seat} ${fresh?'LIZHI':'PLAY'} ${tile.tile}`,validact:null});
  count++;offset++;
 }
 if(confirmation.nextDraw){
  if((seats.self+offset)%GAME.players!==seats.self)throw Error('Own draw out of turn');
  requests.push({state:`2 ${confirmation.nextDraw}`,validact:null});count++;
 }
 if(!Number.isInteger(a.remaining.value)||!Number.isInteger(b.remaining.value))throw Error('Unaccounted wall movement');
 const delta=a.remaining.value-b.remaining.value;
 // The last visible opponent may have drawn but not discarded yet. Its
 // unknown tile is never inferred; require the exact next seat's turn lamp.
 if(!confirmation.nextDraw&&delta===count+1){
  const nextSeat=(seats.self+offset)%GAME.players;
  if(nextSeat===seats.self||seats[b.turn?.position]!==nextSeat)throw Error('Unverified pending opponent draw');
  requests.push({state:`3 ${nextSeat} DRAW`,validact:null});count++;
 }
 if(delta!==count)throw Error('Unaccounted wall movement');
 return {verified:true,requests,confirmation,source:{before:before.id,after:after.id},scope:'accepted riichi, unchanged melds, complete ordered rivers and exact wall delta'};
}
