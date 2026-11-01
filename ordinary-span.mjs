import {depositsConsistent} from './riichi-deposits.mjs';
import {verifyDiscard} from './discard-verification.mjs';
import {fillWall} from './wall-estimate.mjs';
import {canonicalMelds} from './meld-events.mjs';
// Recover a PREFIX of an ordinary cycle after our confirmed discard.
// Calls, repeated turns, unknown pixels and round transitions
// are deliberately excluded. Optional tsumogiri is never invented.
export function ordinarySpan(decision,before,after){
  const candidate=structuredClone(after);
  const result=ordinaryCandidate(decision,before,candidate);
  // A called-away discard can make an ordinary prefix appear shorter but
  // otherwise valid. Route the new exposed meld before comparing that prefix
  // with committed requests or correcting the visible wall count.
  for(const p of ['right','opposite','left']){
    const a=before.opponent_melds?.[p],b=candidate.opponent_melds?.[p];
    const signature=(frame,melds)=>JSON.stringify(canonicalMelds(frame,p,melds).map(m=>JSON.stringify(m)).sort());
    if(a?.complete&&b?.complete&&signature(before,a)!==signature(candidate,b))
      throw Error('New opponent meld requires call continuation');
  }
  // Failed ordinary hypotheses must not alter the wall read used by the
  // subsequent call-chain hypothesis or by a future committed anchor.
  after.round.remaining=candidate.round.remaining;
  return result;
}
function ordinaryCandidate(decision,before,after){
  const confirmation=verifyDiscard(decision,before,after),a=before.round,b=after.round;
  if(a.wind!==b.wind||a.hand_number.value!==b.hand_number.value||
     a.counters.honba!==b.counters.honba||
     !Number.isInteger(a.counters.riichi_sticks)||!Number.isInteger(b.counters.riichi_sticks))
    throw Error('Round/declaration transition');
  const ownDeposit=decision.output.response.startsWith('LIZHI ')?1:0;
  const deposits=b.counters.riichi_sticks-a.counters.riichi_sticks-ownDeposit;
  if(deposits>3)throw Error('Unaccounted riichi deposits');
  if(!a.seat_identity.verified||!b.seat_identity.verified||JSON.stringify(a.seat_identity.seats)!==JSON.stringify(b.seat_identity.seats))
    throw Error('Unknown or changed seats');
  const seats=a.seat_identity.seats,requests=[],acceptedRiichi=[];let count=0,ended=false;
  for(let offset=1;offset<=3;offset++){
    const seat=(seats.self+offset)%4,position=Object.keys(seats).find(p=>seats[p]===seat);
    const old=before.rivers[position],next=after.rivers[position];
    if(!old.complete||!next.complete||old.tiles.some((t,i)=>t.tile!==next.tiles[i]?.tile))throw Error('Incomplete or changed river');
    const added=next.tiles.length-old.tiles.length;
    if(![0,1].includes(added)||(ended&&added))throw Error('Not a single ordered cycle prefix');
    if(!added){ended=true;continue;}
    const sideways=next.tiles.at(-1).sideways;
    if(typeof sideways!=='boolean')throw Error('Unknown discard orientation');
    if(sideways){
      if(old.tiles.some(t=>t.sideways===true))throw Error('Repeated riichi declaration');
      acceptedRiichi.push({seat,eventId:`${after.id}:${seat}:riichi`,confirmed:true});
    }
    count++;
    requests.push({state:`3 ${seat} DRAW`,validact:null},{state:`3 ${seat} ${sideways?'LIZHI':'PLAY'} ${next.tiles.at(-1).tile}`,validact:null});
  }
  let pendingRiichi=null;
  // A declaration discard can be won before its deposit is accepted.
  // Only the current visible reaction may remain unpaid.
  if(acceptedRiichi.length===deposits+1&&after.controls?.PASS&&/ LIZHI /.test(requests.at(-1)?.state??''))
    pendingRiichi=acceptedRiichi.pop();
  if(!depositsConsistent(before,after,acceptedRiichi.length+(pendingRiichi?1:0)+ownDeposit))throw Error('Declarations disagree with paid deposits');
  if(Number.isInteger(a.remaining.value)&&!Number.isInteger(b.remaining.value)){
    const next=(seats.self+count+1)%4;
    const drawing=confirmation.nextDraw||(!after.controls?.PASS&&seats[b.turn?.position]===next);
    fillWall(after,Math.max(0,a.remaining.value-count-(drawing?1:0)),'verified-cycle-events');
  }
  // Exact hand removal + all three new discards prove the draw count.
  // A contradictory OCR numeral cannot invalidate that event sequence.
  if(confirmation.nextDraw&&count===3&&Number.isInteger(a.remaining.value))
    fillWall(after,Math.max(0,a.remaining.value-4),'verified-full-cycle-over-ocr');
  let delta=a.remaining.value-b.remaining.value;
  if(!Number.isInteger(a.remaining.value))throw Error('Missing committed wall basis');
  if(!Number.isInteger(b.remaining.value)||![count,count+1].includes(delta)){
    fillWall(after,Math.max(0,a.remaining.value-count),'confirmed-discards-over-ocr');delta=count;
  }
  if(confirmation.nextDraw){
    if(count!==3||delta!==4)throw Error('Own next draw has intervening events');
    requests.push({state:`2 ${confirmation.nextDraw}`,validact:'PLAY'});
  }else if(delta===count+1){
    if(count===3)return {...confirmation,requests,acceptedRiichi,pendingRiichi};
    const seat=(seats.self+count+1)%4;
    if(seats[b.turn?.position]===seat)requests.push({state:`3 ${seat} DRAW`,validact:null});
  }
  return {...confirmation,requests,acceptedRiichi,pendingRiichi,scope:'single cycle prefix with independently confirmed riichi deposits; no inferred tsumogiri flags'};
}
