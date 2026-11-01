import {roundIdentity} from './round-boundary.mjs';
import {openingPrefix} from './opening-prefix.mjs';

export function snapshotPointContext(frame,snapshot,context){
 const r=roundIdentity(frame),sticks=frame.round?.counters?.riichi_sticks;
 if(!r||!frame.table_scores?.complete||!Number.isInteger(sticks)||sticks<0)throw Error('Incomplete center scores');
 const scores=[];
 for(const p of ['self','right','opposite','left'])scores[r.seats[p]]=frame.table_scores.scores[p]?.value;
 const bank=context.scores.reduce((a,b)=>a+b,0)+1000*context.riichi_sticks;
 if(scores.some(v=>!Number.isInteger(v)||v%100)||scores.reduce((a,b)=>a+b,0)+1000*sticks!==bank)throw Error('Center scores do not conserve points');
 // The bot replays accepted declarations from requests. Undo their deposits
 // in the starting context so that current table balances are charged once.
 const declared=new Set(snapshot.requests.flatMap(q=>{const m=q.state?.match(/^3 ([0-3]) LIZHI /);return m?[Number(m[1])]:[];}));
 if(declared.size>sticks)throw Error('Center deposits and observed declarations disagree');
 for(const seat of declared)scores[seat]+=1000;
 return {...context,scores,riichi_sticks:sticks-declared.size,estimated:false,assumptions:[],source:'table-center-midgame'};
}

// Current table balances are opening balances only before the first own turn
// and before any declaration/call. Never double-subtract a live riichi deposit.
export class TableScoreCollector {
 constructor(){this.frame=null;this.key=null;this.candidate=null;}
 observe(frame){
  this.candidate=null;
  if(!frame?.table_scores?.complete||frame.settlement?.complete)return;
  const r=roundIdentity(frame);
  try{openingPrefix(frame,{allowPending:true});}catch{return;}
  const values=['self','right','opposite','left'].map(p=>frame.table_scores.scores[p]?.value);
  if(values.some(v=>!Number.isInteger(v)||v%100)||!Number.isFinite(frame.capturedAt))return;
  const key=JSON.stringify([r,values,frame.round.counters.riichi_sticks]);
  if(key!==this.key){this.frame=frame;this.key=key;return;}
  if(frame.id===this.frame.id||frame.capturedAt-this.frame.capturedAt<500)return;
  this.candidate={frame,firstId:this.frame.id};
 }
}

export function tableScoreSettlement(previous,stable,next){
 if(stable?.frame.id!==next.id)throw Error('Stable current table scores required');
 const r=roundIdentity(next);
 if(!r||!next.table_scores?.complete)throw Error('Incomplete center scores');
 const sticks=next.round.counters.riichi_sticks;
 const scores=[];
 for(const p of ['self','right','opposite','left'])scores[previous.seats[p]]=next.table_scores.scores[p].value;
 if(scores.length!==4||scores.some(v=>!Number.isInteger(v)||v%100))throw Error('Invalid center scores');
 const bank=previous.context.scores.reduce((a,b)=>a+b,0)+1000*previous.context.riichi_sticks;
 if(!Number.isInteger(sticks)||sticks<0||scores.reduce((a,b)=>a+b,0)+1000*sticks!==bank)throw Error('Table scores do not conserve points');
 if(r.wind===(previous.wind??0)&&r.hand===previous.context.hand_index&&r.honba===previous.context.honba)throw Error('Same hand table scores are not settlement');
 return {verified:true,source:'visible-settlement',scoreSource:'table-center-fixed-regions',scores,seats:previous.seats,
  observationId:next.id,observationIds:[stable.firstId,next.id],riichiSticks:sticks,
  progressionEvidence:'settlement-and-next-opening',nextObservationId:next.id};
}
