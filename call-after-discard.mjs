import {verifyDiscard} from './discard-verification.mjs';
import {validateMeld} from './meld-state.mjs';
const positions=['self','right','opposite','left'];
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
// One next-player draw/discard, immediately called by another opponent.
// The called tile may no longer be in the river; its exact identity and source
// must come from a newly observed meld, never from the actor's hidden hand.
export function callAfterDiscard(decision,before,after,{actor,oldMelds,newMelds}){
  const confirmation=verifyDiscard(decision,before,after);
  if(confirmation.nextDraw)throw Error('Call followed by an unaccounted own draw');
  const a=before.round,b=after.round;
  if(a.wind!==b.wind||a.hand_number.value!==b.hand_number.value||!equal(a.counters,b.counters))throw Error('Round or deposits changed');
  if(!a.seat_identity.verified||!b.seat_identity.verified||!equal(a.seat_identity.seats,b.seat_identity.seats))throw Error('Unknown seats');
  if(!Number.isInteger(a.remaining.value)||a.remaining.value-b.remaining.value!==1)throw Error('Exactly one intervening draw required');
  const seats=a.seat_identity.seats,source=(seats.self+1)%4;
  if(!positions.includes(actor)||actor==='self'||seats[actor]===source)throw Error('Invalid call actor');
  const rest=newMelds.map(validateMeld);
  for(const old of oldMelds.map(validateMeld)){
    const i=rest.findIndex(m=>equal(m,old));
    if(i<0)throw Error('Old meld changed');rest.splice(i,1);
  }
  if(rest.length!==1||!['CHI','PENG'].includes(rest[0].kind))throw Error('One newly verified chi or pung required');
  const meld=rest[0];
  if(meld.from!==source||(meld.kind==='CHI'&&(seats[actor]+3)%4!==source))throw Error('Source does not match next player');
  let discard;
  for(const position of positions.filter(p=>p!=='self')){
    const old=before.rivers[position],next=after.rivers[position];
    if(!old.complete||!next.complete)throw Error('Incomplete river');
    const expected=old.tiles.map(t=>t.tile);
    if(position===actor){
      const last=next.tiles.at(-1);
      if(!last||last.sideways!==false)throw Error('Post-call discard unknown');
      discard=last.tile;expected.push(discard);
    }
    if(!equal(expected,next.tiles.map(t=>t.tile)))throw Error('Additional unaccounted river change');
  }
  const own=[...meld.tiles],called=own.splice(meld.calledIndex,1)[0];
  return {verified:true,requests:[{state:`3 ${source} DRAW`,validact:null},{state:`3 ${source} PLAY ${called}`,validact:null},
    {state:`3 ${seats[actor]} ${meld.kind} ${called} ${own.join(' ')} ${discard}`,validact:null}],before:before.id,after:after.id};
}
