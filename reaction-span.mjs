import {GAME,remainingHands} from './game-rules.mjs';
import {declaredSeats} from './confirmed-riichi.mjs';
import {depositsConsistent} from './riichi-deposits.mjs';
import {canonicalMelds} from './meld-events.mjs';
import {fillWall} from './wall-estimate.mjs';
import {openingPrefix} from './opening-prefix.mjs';
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const hand=f=>f.hand.tiles.map(t=>t.tile);
const sorted=a=>[...a].sort().join(' ');
export function reactionSpan(before,after,lastSeat,{committedDraw=null,history=[]}={}){
 const a=before.round,b=after.round,seats=a.seat_identity.seats;
 if(lastSeat==null){
  // A new-hand snapshot can contain the dealer draw but no discard yet.
  // Establish the prefix from the actual opening instead of inventing a prior actor.
  const end=openingPrefix(after,{allowPending:true}),initial=structuredClone(before);
  // The later verified opening has no calls. Resolve a transient empty
  // opponent meld band in the earlier all-empty-river frame from that evidence.
  if(Object.values(initial.rivers).every(r=>r.complete&&r.tiles.length===0))
   for(const p of GAME.opponents){
    const m=initial.opponent_melds?.[p];
    if(m&&!m.complete&&m.groups.length===0)initial.opponent_melds[p]={...m,complete:true};
   }
  const start=openingPrefix(initial,{allowPending:true});
  if(!eq(start.round,end.round)||sorted(start.hand)!==sorted(end.hand)||start.indicator!==end.indicator||start.requests.length)
   throw Error('Unverified initial actor boundary');
  const requests=[...end.requests];
  if(a.remaining.value===(GAME.initialWall-1)&&requests[0]?.state==='3 0 DRAW')requests.shift();
  return {verified:true,requests,nextDraw:end.draw};
 }
 if(!Number.isInteger(lastSeat)||lastSeat<0||lastSeat>=GAME.players)throw Error('Previous actor unavailable');
 if(a.wind!==b.wind||a.hand_number.value!==b.hand_number.value||a.counters.honba!==b.counters.honba||!a.seat_identity.verified||!b.seat_identity.verified||!eq(seats,b.seat_identity.seats))throw Error('Unaccounted round or seats');
 if(!before.hand.complete||!after.hand.complete)throw Error('Incomplete hand');
 const extra={};
 for(const p of GAME.positions){
  const old=before.rivers[p],next=after.rivers[p];
  if(!old.complete||!next.complete||old.tiles.some((t,i)=>t.tile!==next.tiles[i]?.tile||t.sideways!==next.tiles[i]?.sideways))throw Error('Incomplete river');
  const changes=next.tiles.slice(old.tiles.length);if(changes.some(t=>typeof t.sideways!=='boolean'))throw Error('Unknown discard orientation');
  extra[seats[p]]=changes;
  if(!eq(canonicalMelds(before,p,p==='self'?before.own_melds:before.opponent_melds[p]),canonicalMelds(after,p,p==='self'?after.own_melds:after.opponent_melds[p])))throw Error('Intervening call');
 }
 if(extra[seats.self].length)throw Error('Unaccounted own discard');
 const requests=[];let turn=committedDraw??(lastSeat+1)%GAME.players,count=0,declarations=0;
 while(turn!==seats.self&&extra[turn].length){
  if(extra[turn].length!==1)throw Error('More than one cycle');
  const t=extra[turn].shift(),position=Object.keys(seats).find(p=>seats[p]===turn);
  const declaring=t.sideways&&!before.rivers[position].tiles.some(v=>v.sideways)&&!declaredSeats(history).has(turn);
  declarations+=declaring?1:0;
  if(!(requests.length===0&&committedDraw===turn)){requests.push({state:`3 ${turn} DRAW`,validact:null});count++;}
  requests.push({state:`3 ${turn} ${declaring?'LIZHI':'PLAY'} ${t.tile}`,validact:null});turn=(turn+1)%GAME.players;
 }
 if(Object.values(extra).some(t=>t.length))throw Error('Skipped actor');
 const visible=hand(after);let nextDraw=null;
 if(visible.length===hand(before).length+1){
  const tiles=after.hand.tiles;if(turn!==seats.self||tiles.at(-1).center[0]-tiles.at(-2).center[0]<80)throw Error('Unproved draw');
  nextDraw=visible.pop();requests.push({state:`2 ${nextDraw}`,validact:'PLAY'});count++;
 }
 if(sorted(visible)!==sorted(hand(before)))throw Error('Unexpected hand change');
 if(!depositsConsistent(before,after,declarations))throw Error('Declarations disagree with paid deposits');
 // The same frame may show a discard AND the following opponent's draw.
 // Keep that draw with its actual actor instead of attributing the wall
 // decrement to an already committed draw by the discarder.
 if(!nextDraw&&requests.length&&turn!==seats.self&&!after.controls?.PASS&&
    seats[b.turn?.position]===turn&&a.remaining.value-b.remaining.value===count+1){
  requests.push({state:`3 ${turn} DRAW`,validact:null});count++;
 }
 if(Number.isInteger(a.remaining.value)&&!Number.isInteger(b.remaining.value))fillWall(after,Math.max(0,a.remaining.value-count),'verified-reaction-events');
 if(Number.isInteger(a.remaining.value)&&a.remaining.value-b.remaining.value!==count)
  fillWall(after,Math.max(0,a.remaining.value-count),'verified-reaction-events-over-ocr');
 if(!Number.isInteger(a.remaining.value))throw Error('Missing committed wall basis');
 return {verified:true,requests,nextDraw};
}
