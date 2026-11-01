export const SETTLEMENT_STABLE_MS=1500;
// A stable score overlay is a candidate only. The following first-turn
// counters must account for every point before it becomes a checkpoint.
export function passiveSettlementCandidate(first,second,seats){
 if(!first?.id||first.id===second?.id||!first.settlement?.complete||!second.settlement?.complete)throw Error('Two complete distinct settlement observations required');
 if(!Number.isFinite(first.capturedAt)||!Number.isFinite(second.capturedAt)||second.capturedAt-first.capturedAt<SETTLEMENT_STABLE_MS)throw Error('Settlement has not stayed stable for 1.5 seconds');
 if(!seats||Object.values(seats).sort().join(',')!=='0,1,2,3')throw Error('Verified seats required');
 const scores=[];
 for(const p of ['self','right','opposite','left']){
  const a=first.settlement.scores[p]?.value,b=second.settlement.scores[p]?.value;
  if(a!==b||!Number.isInteger(b)||b%100)throw Error('Unstable settlement');
  scores[seats[p]]=b;
 }
 return {verified:false,source:'visible-settlement-candidate',scores,seats,
  observationId:second.id,observationIds:[first.id,second.id]};
}
export function finalizePassiveSettlement(previous,candidate,next){
 if(candidate?.source!=='visible-settlement-candidate'||new Set(candidate.observationIds).size!==2)throw Error('Stable settlement candidate required');
 const sticks=next.round?.counters?.riichi_sticks;
 // Stable overlay is authoritative even if previous points were estimated.
 if(!Number.isInteger(sticks)||sticks<0)throw Error('Next deposits unreadable');
 return {...candidate,verified:true,source:'visible-settlement',riichiSticks:sticks,
  progressionEvidence:'settlement-and-next-opening',nextObservationId:next.id};
}

// Retain a stable result across hidden overlays and pending action phases.
export class SettlementCollector {
 constructor(){this.reset();}
 reset(){this.frame=null;this.candidate=null;}
 observe(frame,seats){
  if(!frame?.settlement?.complete||!seats)return;
  if(frame.id===this.frame?.id)return;
  const values=f=>JSON.stringify(['self','right','opposite','left'].map(p=>f?.settlement?.scores[p]?.value));
  if(!this.frame||values(this.frame)!==values(frame)){this.frame=frame;this.candidate=null;return;}
  try{this.candidate=passiveSettlementCandidate(this.frame,frame,seats);}catch{this.candidate=null;}
 }
}
