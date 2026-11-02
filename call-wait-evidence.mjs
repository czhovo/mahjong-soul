import {newDiscardEvidence} from './current-decision.mjs';
import {roundIdentity} from './round-boundary.mjs';
import {ConstraintHandChanges} from './constraint-hand-changes.mjs';

const normalized=tile=>typeof tile==='string'?tile.replace(/^([WBT])0$/,(_,s)=>s+'5'):null;
const order=['self','right','opposite','left'];
const meldIdentity=g=>JSON.stringify([g.kind,g.tiles,g.calledIndex,g.fromRelative]);
function remainingCopies(frame,tile){
 const target=normalized(tile);
 const count=tiles=>(tiles??[]).filter(t=>normalized(typeof t==='string'?t:t?.tile)===target).length;
 let known=count(frame.hand?.tiles)+count(frame.dora?.tiles);
 for(const position of ['self','left','opposite','right']){
  known+=count(frame.rivers?.[position]?.tiles);
  const melds=position==='self'?frame.own_melds:frame.opponent_melds?.[position];
  for(const group of melds?.groups??[])known+=count(group.tiles);
 }
 // Readable copies alone suffice to rule out a pair. Missing regions never
 // become invented copies or a reason to block the main decision loop.
 return {known_copies:known,remaining_upper_bound:Math.max(0,4-known)};
}

// Recognize v4 retains historical observations internally and exports updated
// current disjunctive lower bounds, without enumerating hand assignments.
export class CallWaitEvidence {
 constructor({onDetected}={}){this.onDetected=onDetected;this.key=null;this.before=null;this.pending=null;this.events=[];this.changes=new ConstraintHandChanges();}
 observe(frame){
  const round=roundIdentity(frame);
  if(!round)return {schema:2,time_scope:'current',constraints:[]};
  const key=JSON.stringify(round);
  if(key!==this.key){this.key=key;this.before=null;this.previousMelds={};this.pending=null;this.events=[];this.changes=new ConstraintHandChanges();}
  const invalid=this.changes.observe(frame);
  if(invalid.size){this.events=[];this.pending=null;}
  const fresh=newDiscardEvidence(this.before,frame,{includeSelf:true});
  if(fresh&&!(this.pending?.position===fresh.position&&this.pending.slot===fresh.slot&&this.pending.tile===fresh.tile))
   this.pending=(fresh.position==='left'||/^Z[1-7]$/.test(fresh.tile))?{...fresh,discardFrameId:frame.id,startedAt:frame.capturedAt}:null;
  const p=this.pending,hand=frame.hand,melds=frame.own_melds;
  const turn=frame.round?.turn?.position;
  if(p){
   const next=order[(order.indexOf(p.position)+1)%4];
   const candidates=['left','opposite','right'].filter(v=>v!=='self'&&v!==p.position);
   const meldsUnchanged=Object.entries(p.melds??{}).every(([pos,value])=>{
    const m=pos==='self'?frame.own_melds:frame.opponent_melds?.[pos];
    return value===null||m?.complete&&value===JSON.stringify(m.groups.map(g=>JSON.stringify([g.kind,[...g.tiles].sort(),g.fromRelative,g.tiles[g.calledIndex]])).sort());
   });
   if(turn==null)p.sawDark=true;
   if(turn===p.position&&p.sawDark)p.relit=true;
   if(frame.capture_stall?.active===true||(Number.isFinite(frame.capture_stall?.lastAt)&&frame.capture_stall.lastAt>=p.startedAt))p.stalled=true;
   const river=frame.rivers?.[p.position];
   const copies=remainingCopies(frame,p.tile);
   const awaitingDraw=p.candidate&&next==='self'&&turn==='self';
   const ended=(turn!=null&&turn!==p.position&&!awaitingDraw)||
    (hand?.complete&&melds?.complete&&hand.tiles.length===14-3*melds.groups.length)||
    (river?.complete&&(river.tiles.length!==p.slot+1||river.tiles[p.slot]?.tile!==p.tile));
   const drawn=hand?.complete&&melds?.complete&&hand.tiles.length===14-3*melds.groups.length;
   // The normal draw timer can appear one frame before the sliding tile is
   // readable. A timer in that ambiguous frame cannot revoke a prior wait.
   const unresolvedDraw=p.candidate&&next==='self'&&(!hand?.complete||awaitingDraw);
   if(!drawn&&((frame.controls&&Object.keys(frame.controls).length>0)||frame.selection?.verified||frame.call_choices?.verified||(!unresolvedDraw&&frame.time_reserve?.countdown_absent===false)))p.ownAction=true;
   const sameRiver=river?.complete&&river.tiles.length===p.slot+1&&river.tiles[p.slot]?.tile===p.tile;
   if(!p.ownAction&&!p.stalled&&p.candidate&&this.changes.sequence===p.candidate.since&&melds?.groups?.length===p.meldCount&&sameRiver&&meldsUnchanged&&(next==='self'?drawn&&(turn==null||turn==='self'):turn===next)){
    this.events.push(p.candidate);this.pending=null;
    this.onDetected?.(p.candidate);
   }else if(ended||p.ownAction||!meldsUnchanged||copies.remaining_upper_bound<2)this.pending=null;
   else if(!p.stalled&&(p.relit||(Number.isFinite(frame.capturedAt)&&frame.capturedAt-p.startedAt>=500))&&hand?.complete&&melds?.complete&&
     hand.tiles.length===13-3*melds.groups.length&&
     frame.controls&&Object.keys(frame.controls).length===0&&
     river?.complete&&river.tiles[p.slot]?.color?.verified&&!river.tiles[p.slot]?.tracking){
    p.meldCount=melds.groups.length;
    p.candidate??={since:this.changes.sequence,id:`call-wait:${p.discardFrameId}`,kind:'opponent_pair_disjunction',
     round:structuredClone(round),tile:normalized(p.tile),
     candidate_positions:candidates,candidate_seats:candidates.map(v=>round.seats[v]),minimum_count:2,
     quantifier:'at_least_one',time_scope:'at_observation',
     discard:{seat:round.seats[p.position],tile:p.tile,river_index:p.slot,frame_id:p.discardFrameId},
     observed_frame_id:frame.id,observed_at:frame.capturedAt??null,
     evidence:{wait_ms:frame.capturedAt-p.startedAt,trigger:p.relit?(p.position==='left'?'upstream_lamp_relit':'discarder_lamp_relit'):(p.position==='left'?'no_self_draw_after_500ms':'no_turn_advance_after_500ms'),not_stalled:true,turn_position:turn??null,self_drawn:false,countdown_absent:frame.time_reserve?.countdown_absent===true,...copies},
     source:/^Z[1-7]$/.test(p.tile)?'recognize-v4:honor-discard-call-wait':'recognize-v4:upstream-discard-call-wait'};
   }
  }
  // Incomplete frames do not erase the last readable river prefixes.
  if(!this.before)this.before={round:structuredClone(frame.round),rivers:{}};
  const positions=['self','right','opposite','left'];
  for(const pos of order)if(frame.rivers?.[pos]?.complete){
   const old=this.before.rivers[pos],next=frame.rivers[pos];
   if(old&&next.tiles.length<old.tiles.length){
    // Only a new exposed call taking the old tail proves a real removal.
    // A complete flag alone cannot erase an already observed discard.
    const removed=old.tiles.at(-1),source=positions.indexOf(pos);
    const called=next.tiles.length===old.tiles.length-1&&next.tiles.every((t,i)=>t.tile===old.tiles[i].tile)&&positions.some((owner,index)=>{
     const m=owner==='self'?frame.own_melds:frame.opponent_melds?.[owner];
     if(!m?.complete)return false;
     return m.groups.some(g=>['CHI','PENG','GANG'].includes(g.kind)&&
      ['left','opposite','right'].includes(g.fromRelative)&&Number.isInteger(g.calledIndex)&&
      (index+({left:3,opposite:2,right:1}[g.fromRelative]))%4===source&&
      normalized(g.tiles[g.calledIndex])===normalized(removed.tile)&&
      !(this.previousMelds?.[owner]??[]).some(v=>meldIdentity(v)===meldIdentity(g)));
    });
    if(!called)continue;
   }
   this.before.rivers[pos]=structuredClone(next);
  }
  this.previousMelds??={};
  for(const p of positions){const m=p==='self'?frame.own_melds:frame.opponent_melds?.[p];if(m?.complete)this.previousMelds[p]=structuredClone(m.groups);}
  const candidates=this.events.map(e=>({id:e.id,tile:e.tile,
   any_of:(e.candidate_positions??['opposite','right']).map(position=>({seat:round.seats[position],minimum_count:Math.max(0,2-this.changes.lossSince(e.since,position,e.tile))})),
   observed_frame_id:e.observed_frame_id,discard:structuredClone(e.discard),evidence:structuredClone(e.evidence)}))
   .filter(c=>c.any_of.every(a=>a.minimum_count>0));
  // (A>=a OR B>=b) implies weaker constraints with both thresholds lower.
  // Export only the strongest nonduplicate clauses; never expand assignments.
  const constraints=candidates.filter((c,i)=>!candidates.some((d,j)=>j!==i&&d.tile===c.tile&&d.any_of.length===c.any_of.length&&d.any_of.every((a,k)=>a.seat===c.any_of[k].seat)&&
   d.any_of.every((a,k)=>a.minimum_count>=c.any_of[k].minimum_count)&&
   (j<i||d.any_of.some((a,k)=>a.minimum_count>c.any_of[k].minimum_count))));
  return {schema:2,time_scope:'current',round:structuredClone(round),as_of_frame_id:frame.id,constraints};
 }
}
