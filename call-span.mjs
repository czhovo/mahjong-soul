import {GAME,remainingHands} from './game-rules.mjs';
import {verifyDiscard} from './discard-verification.mjs';
import {validateMeld} from './meld-state.mjs';
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function callSpan(decision,before,after,{actor,oldMelds,newMelds}){
 const confirmation=verifyDiscard(decision,before,after),a=before.round,b=after.round;
 if(confirmation.nextDraw||a.wind!==b.wind||a.hand_number.value!==b.hand_number.value||!equal(a.counters,b.counters))throw Error('Unaccounted round or own draw');
 if(!a.seat_identity.verified||!b.seat_identity.verified||!equal(a.seat_identity.seats,b.seat_identity.seats))throw Error('Unknown seats');
 const seats=a.seat_identity.seats,caller=seats[actor],rest=newMelds.map(validateMeld);
 if(!Number.isInteger(caller)||caller===seats.self)throw Error('Opponent caller required');
 for(const old of oldMelds.map(validateMeld)){const i=rest.findIndex(m=>equal(m,old));if(i<0)throw Error('Old meld changed');rest.splice(i,1);}
 if(rest.length!==1||!['CHI','PENG'].includes(rest[0].kind))throw Error('One chi or pung required');
 const meld=rest[0],source=meld.from,own=[...meld.tiles],called=own.splice(meld.calledIndex,1)[0];
 if(source===seats.self||source===caller||(meld.kind==='CHI'&&(caller+(GAME.players-1))%GAME.players!==source))throw Error('Unsupported source');
 const queues={};
 for(const p of GAME.opponents){
  const old=before.rivers[p],next=after.rivers[p];
  if(!old.complete||!next.complete||old.tiles.some((t,i)=>t.tile!==next.tiles[i]?.tile||t.sideways!==next.tiles[i]?.sideways))throw Error('Incomplete or changed river');
  const extra=next.tiles.slice(old.tiles.length);if(extra.some(t=>t.sideways!==false))throw Error('Unknown declaration');queues[seats[p]]=extra.map(t=>t.tile);
 }
 const draws=a.remaining.value-b.remaining.value;
 if(!Number.isInteger(draws)||draws<1||draws>12)throw Error('Invalid wall delta');
 const solutions=[];
 function search(turn,q,used,n,requests){
  if(n===draws&&used&&Object.values(q).every(x=>!x.length)){solutions.push(requests);return;}
  if(n>=draws||turn===seats.self||solutions.length>1)return;
  const prefix=[...requests,{state:`3 ${turn} DRAW`,validact:null}];
  if(q[turn]?.length){const copy=structuredClone(q),tile=copy[turn].shift();search((turn+1)%GAME.players,copy,used,n+1,[...prefix,{state:`3 ${turn} PLAY ${tile}`,validact:null}]);}
  if(!used&&turn===source&&q[caller]?.length){const copy=structuredClone(q),discard=copy[caller].shift();search((caller+1)%GAME.players,copy,true,n+1,[...prefix,{state:`3 ${source} PLAY ${called}`,validact:null},{state:`3 ${caller} ${meld.kind} ${called} ${own.join(' ')} ${discard}`,validact:null}]);}
 }
 search((seats.self+1)%GAME.players,queues,false,0,[]);
 if(solutions.length!==1)throw Error('Call history is absent or ambiguous');
 return {verified:true,requests:solutions[0],before:before.id,after:after.id,scope:'unique call-free turns surrounding one independently visible call'};
}
