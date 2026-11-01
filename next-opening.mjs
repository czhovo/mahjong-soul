import {roundIdentity} from './round-boundary.mjs';
import {openingPrefix} from './opening-prefix.mjs';
import {snapshotRecovery} from './snapshot-recovery.mjs';
export function estimatedNextOpening(previous,frame){
 let prefix;
 try{prefix=openingPrefix(frame,{allowPending:true});}
 catch{prefix={snapshot:snapshotRecovery(frame)};}
 const r=roundIdentity(frame),scores=[];
 if(!previous.context?.scores||!previous.seats)throw Error('Previous score basis missing');
 if(r.wind===(previous.wind??0)&&r.hand===previous.context.hand_index&&r.honba===previous.context.honba)throw Error('Still in the same hand');
 for(const p of ['self','right','opposite','left'])scores[r.seats[p]]=previous.context.scores[previous.seats[p]];
 const sticks=frame.round.counters.riichi_sticks;
 if(!Number.isInteger(sticks))throw Error('Opening deposits unreadable');
 const delta=((previous.context.riichi_sticks??0)-sticks)*1000;
 // Unknown settlement is a deliberate approximation, never a confirmed ledger.
 scores[r.seats.self]+=delta;
 return {...prefix,wind:r.wind,seats:r.seats,openingFrame:frame,context:{...previous.context,scores,riichi_sticks:sticks,honba:r.honba,hand_index:r.hand,
  remaining_scheduled_hands:r.wind===0?5-r.hand:1,is_last_scheduled_hand:r.wind>0||r.hand===4,
  tie_priority:[0,1,2,3].map(s=>(s-r.hand+5)%4),estimated:true,
  source:'estimated-missing-settlement',assumptions:['结算漏读，沿用上次已知点数并按座位映射','未知点数转移暂按零估计；供托差额暂记自己']}};
}

// Carry only an already verified settlement into an observed first turn.
// Center-score proofs must already be stable, conserved and mapped to old seats.
export function nextOpening(previous,proof,frame,{allowSnapshot=false}={}){
 if(!proof?.verified||proof.source!=='visible-settlement'||!Number.isInteger(proof.riichiSticks)||proof.riichiSticks<0)throw Error('Verified settlement required');
 let prefix;
 try{prefix=openingPrefix(frame,{allowPending:allowSnapshot});}catch(error){
  if(!allowSnapshot)throw error;
  prefix={snapshot:snapshotRecovery(frame)};
 }
 const r=roundIdentity(frame);
 const oldHand=previous.context.hand_index;
 const oldWind=previous.wind??previous.resume?.before?.round?.wind;
 const repeated=r.wind===oldWind&&r.hand===oldHand&&r.honba===previous.context.honba+1;
 const passive=proof.progressionEvidence==='settlement-and-next-opening'&&proof.nextObservationId===frame.id;
 const advanced=r.wind===oldWind+(oldHand===4?1:0)&&r.hand===(oldHand===4?1:oldHand+1)&&(r.honba===0||(passive&&r.honba===previous.context.honba+1));
 if(!repeated&&!advanced)throw Error('Unverified round progression');
 const seats=r.seats,oldSeats=proof.seats,scores=[],permutation=[];
 for(const p of ['self','right','opposite','left']){
  if(seats[p]!==((oldSeats[p]+(advanced?3:0))%4))throw Error('Seat progression mismatch');
  scores[seats[p]]=proof.scores[oldSeats[p]];permutation[oldSeats[p]]=seats[p];
 }
 if(frame.round.counters.riichi_sticks!==proof.riichiSticks)throw Error('Opening counters not verified');
 return {...prefix,wind:r.wind,seats,hand:prefix.hand,draw:prefix.draw,
  indicator:prefix.indicator,rivers:prefix.rivers,openingFrame:frame,
  context:{...previous.context,estimated:false,assumptions:[],scores,riichi_sticks:proof.riichiSticks,honba:r.honba,hand_index:r.hand,
   remaining_scheduled_hands:r.wind===0?5-r.hand:1,is_last_scheduled_hand:r.wind>0||r.hand===4,
   tie_priority:previous.context.tie_priority.map(s=>permutation[s]),source:`verified-settlement:${proof.observationId};opening:${frame.id}`}};
}
