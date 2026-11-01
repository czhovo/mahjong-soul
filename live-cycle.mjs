import {AutoWin} from './auto-win.mjs';
import {declaredSeats} from './confirmed-riichi.mjs';
import {appendEvidence} from './background-evidence.mjs';
import {currentDecision,newDiscardEvidence,ReactionObservationCache} from './current-decision.mjs';
import {applyPublicEvent} from './hand-ledger.mjs';
import {ordinarySpan} from './ordinary-span.mjs';
import {verifyDiscard,verifyLocalDiscard,verifyCalledDiscard,replacedDiscard,discardLeftHand} from './discard-verification.mjs';
import {visibleActions} from './visible-actions.mjs';
import {canonicalMelds} from './meld-events.mjs';
import {overriddenCall,callOverriddenByRon} from './overridden-call.mjs';
import {callAfterDiscard} from './call-after-discard.mjs';
import {callSpan} from './call-span.mjs';
import {trackOccludedRivers,RiverObservationCache,MeldObservationCache} from './river-tracking.mjs';
import {advanceStaged} from './staged-action.mjs';
import {riichiSpan} from './riichi-span.mjs';
import {publicContinuation} from './public-continuation.mjs';
import {repairAnchorEvidence,completeDecodedRivers} from './anchor-evidence.mjs';
import {chainedCallSpan} from './chained-call-span.mjs';
import {verifyKongDraw} from './kong-transition.mjs';
import {verifyWinSettlement} from './win-settlement.mjs';
import {sameReactionWindow} from './reaction-window.mjs';
import {changedRound,roundIdentity} from './round-boundary.mjs';
import {SettlementCollector,SETTLEMENT_STABLE_MS} from './passive-settlement.mjs';
import {openingPrefix} from './opening-prefix.mjs';
import {unchangedDiscard} from './unchanged-discard.mjs';
import {awaitingTsumoControl} from './tsumo-guard.mjs';
import {VisibleEventLog} from './visible-event-log.mjs';
import {recoverOwnKong} from './own-kong-recovery.mjs';
import {snapshotRecovery} from './snapshot-recovery.mjs';
import {setTimeout as delay} from 'node:timers/promises';

// A serial observation/decision/output pump. It yields at a round change,
// unaccounted public event, or staged special action, retaining exact state.
// No inferred hidden events or duplicate bot requests. A single retry requires independently verified absence of the input effect.
export class LiveCycle {
  constructor(adapter,session,{decision,before,evidence}){
    if(session.pending)throw Error('Start from a confirmed own discard');
    this.adapter=adapter;this.session=session;this.anchor={decision,before};
    this.consumed=[];this.evidence=evidence;this.actions=0;
    this.visibleLog=new VisibleEventLog(before);
  }
  async record(entry){appendEvidence(this.evidence,JSON.stringify({at:new Date().toISOString(),...entry})+'\n');}
  passiveRiichi(frame){
    if(this.pending||this.special||this.win||this.adapter.call||this.session.pending)return false;
    if(declaredSeats(this.session.requests).has(this.session.seat)&&frame.auto_win?.verified&&frame.auto_win.enabled)this.riichiPassive=true;
    return this.riichiPassive===true;
  }
  async updateAutoWin(frame){
    this.autoWin??=new AutoWin();
    const sent=await this.autoWin.update(frame,this.adapter);
    if(sent)await this.record({kind:'auto_win_enable_sent',frame:frame.id});
    if(this.autoWin.confirmedNow)await this.record({kind:'auto_win_confirmed',frame:frame.id});
    return sent;
  }
  async preserveRebuildFrame(frame,reason,kind){
    if(typeof this.adapter.saveRebuildScreenshot!=='function')return null;
    try{
      return await this.adapter.saveRebuildScreenshot(frame,{reason,kind,
        previousFrameId:(this.publicFrame??this.anchor.before)?.id,previousObservation:this.publicFrame??this.anchor.before,
        committedPrefix:[...this.consumed],eventLog:this.evidence});
    }catch(error){
      await this.record({kind:'rebuild_screenshot_save_failed',frame:frame.id,reason:error.message,sourceImage:frame.imagePath});
      return null;
    }
  }
  async reportVisibleEvents(span,frame,publicMode){
    if(this.independentDisplay)return;
    // This is a display cursor, independent of the bot-history commit cursor.
    // Estimated snapshot events are not fresh observations.
    if(!(span.verified||span.gameConfirmed))return;
    const key=(publicMode?this.publicFrame?.id:null)??this.anchor.before.id;
    if(this.displayKey!==key){this.displayKey=key;this.displayPrefix=[];}
    const states=span.requests.map(e=>e.state);
    if(this.displayPrefix.some((s,i)=>states[i]!==s))return;
    const fresh=span.requests.slice(this.displayPrefix.length).filter(e=>{
      const [type,seat,kind]=(e.state??'').split(' ');
      return type==='3'&&Number(seat)!==frame.round.seat_identity.seats.self&&kind!=='DRAW';
    });
    this.displayPrefix=states;
    if(fresh.length)await this.record({kind:'visible_public_events',frame:frame.id,requests:fresh});
  }
  async waitForEvidence(frame,reason){
    if(await this.repairIdleHistory(this.rawFrame?.id===frame.id?this.rawFrame:frame,reason))
      return {status:'history_repaired',frame:frame.id};
    this.unresolvedSince??=performance.now();
    if(!this.recoveringEvidence){
      this.recoveringEvidence=true;
      await this.record({kind:'evidence_wait',frame:frame.id,reason});
    }
    // Keep the committed history and keep observing. A later complete frame
    // may bridge the gap; settlement/round handling still runs on every step.
    // Never confirm or resend pending mouse input as part of this recovery.
    return {status:'waiting_public_frame',reason};
  }
  observeCallRivers(frame){
    const round=JSON.stringify(roundIdentity(frame));
    if(this.callRiverRound!==round){this.callRiverRound=round;this.callRiverPlayers={};this.idleCallRivers=new Map();}
    const key=g=>JSON.stringify([g.kind,g.tiles,g.calledIndex,g.fromRelative]);
    for(const p of ['right','opposite','left']){
      const melds=frame.opponent_melds?.[p],river=frame.rivers?.[p];
      if(!melds?.complete||!river?.complete||river.rejected?.length)continue;
      const keys=melds.groups.map(key),tiles=river.tiles.map(t=>t.tile),old=this.callRiverPlayers[p];
      if(old)for(const g of melds.groups){
        if(['CHI','PENG'].includes(g.kind)&&!old.keys.includes(key(g)))
          this.idleCallRivers.set(JSON.stringify([p,key(g)]),old.tiles.slice());
      }
      // A transient omission with unchanged melds cannot erase known discards.
      if(old&&JSON.stringify([...old.keys].sort())===JSON.stringify([...keys].sort())&&tiles.length<old.tiles.length)continue;
      this.callRiverPlayers[p]={keys,tiles};
    }
  }
  async repairIdleHistory(frame,reason){
    if(!this.callRiverPlayers)this.observeCallRivers(this.anchor.before);
    this.observeCallRivers(frame);
    const session=this.session;
    // A temporarily shorter river is not a new history. Only an actual
    // meld change can account for a discard being taken off the table.
    const previous=this.publicFrame??this.anchor.before;
    const positions=['self','right','opposite','left'];
    const meldKey=f=>JSON.stringify(positions.map(p=>(p==='self'?f.own_melds?.groups:f.opponent_melds?.[p]?.groups)?.map(g=>[g.kind,g.tiles,g.calledIndex,g.fromRelative])));
    if(previous&&meldKey(previous)===meldKey(frame)&&positions.some(p=>
      (frame.rivers?.[p]?.tiles?.length??0)<(previous.rivers?.[p]?.tiles?.length??0))){
      this.idleRepairCandidate=null;return false;
    }
    // Chi/pung is not finished until the caller discards. The protocol
    // bundles that discard with the call; wait for it without inventing one.
    if(previous&&positions.slice(1).some(p=>{
      const old=previous.opponent_melds?.[p]?.groups??[],now=frame.opponent_melds?.[p]?.groups??[];
      const key=g=>JSON.stringify([g.kind,g.tiles,g.calledIndex,g.fromRelative]);
      const added=now.filter(g=>['CHI','PENG'].includes(g.kind)&&!old.some(m=>key(m)===key(g)));
      if(!added.length)return false;
      const river=frame.rivers?.[p];
      if(!river?.complete)return true;
      const tiles=river.tiles.map(t=>t.tile);
      // Compare with the latest valid observation BEFORE this meld appeared,
      // not the old decision anchor or the first post-call observation.
      return added.some(g=>{
        const beforeCall=this.idleCallRivers.get(JSON.stringify([p,key(g)]));
        return !beforeCall||tiles.length<=beforeCall.length||beforeCall.some((tile,i)=>tiles[i]!==tile);
      });
    })){this.idleRepairCandidate=null;return false;}
    // Repair is permitted only between decisions, with no submitted input
    // awaiting confirmation. Missing current pixels are retried, not invented.
    const blocked=declaredSeats(session.requests).has(session.seat)||this.pending||this.special||this.win||this.outputRecovery||this.kongDraw||session.pending||this.adapter.call||
      Object.keys(frame.controls??{}).length||frame.selection?.verified||frame.call_choices?.verified||
      !frame.hand?.complete||frame.hand.rejected?.length||!frame.own_melds?.complete||
      frame.hand.tiles.length!==13-3*frame.own_melds.groups.length||!roundIdentity(frame)||
      changedRound(this.anchor.before,frame)||!frame.dora?.complete||
      ['self','right','opposite','left'].some(p=>!frame.rivers?.[p]?.complete||frame.rivers[p].rejected?.length)||
      ['right','opposite','left'].some(p=>!frame.opponent_melds?.[p]?.complete);
    if(blocked||typeof session.restoreSnapshot!=='function'){this.idleRepairCandidate=null;return false;}
    const signature=JSON.stringify({round:roundIdentity(frame),hand:frame.hand.tiles.map(t=>t.tile),
      rivers:Object.fromEntries(Object.entries(frame.rivers).map(([p,r])=>[p,r.tiles.map(t=>[t.tile,t.sideways])])),
      melds:['self','right','opposite','left'].map(p=>canonicalMelds(frame,p,p==='self'?frame.own_melds:frame.opponent_melds[p])),
      dora:frame.dora.tiles.map(t=>t.tile)});
    const prior=this.idleRepairCandidate;
    this.idleRepairCandidate={signature,id:frame.id};
    if(!prior||prior.signature!==signature||prior.id===frame.id||this.lastIdleRepairSignature===signature)return false;
    let snapshot;
    try{snapshot=snapshotRecovery(structuredClone(frame),{previous:this.publicFrame??this.anchor.before,history:session.requests});}
    catch{return false;}
    if(snapshot.event)return false;
    session.restoreSnapshot(snapshot);
    const screenshot=await this.preserveRebuildFrame(frame,reason,'idle_history_repaired');
    this.publicFrame=structuredClone(frame);this.consumed=[];this.opening=null;this.openingConsumed=[];this.snapshotEvent=null;
    this.riverObservations=new RiverObservationCache();this.riverObservations.apply(frame);
    this.meldObservations=new MeldObservationCache();this.meldObservations.apply(frame);
    this.reactionObservations=new ReactionObservationCache();this.reactionObservations.observe(frame);
    this.lastDecisionObservation=structuredClone(frame);this.reactionEvidence=null;this.lastReactionKey=null;
    this.lastIdleRepairSignature=signature;this.recoveringEvidence=false;this.unresolvedSince=null;
    appendEvidence(this.evidence,JSON.stringify({at:new Date().toISOString(),kind:'idle_history_repaired',frame:frame.id,reason,screenshot,assumptions:snapshot.assumptions})+'\n');
    this.onHistoryRepair?.(reason);
    return true;
  }
  async recoverPass(frame,reason){return this.recoverTransaction(frame,reason,this.pending);}
  async recoverTransaction(frame,reason,pending,{onlyCallCheck=false}={}){
    const session=this.session,action=pending.decision?.output?.response;
    if(pending===this.special&&['CHI','PENG'].includes(action?.split(' ')[0])&&
       session.pending===pending.decision&&typeof session.dismissUnexecutedCall==='function'&&
       !pending.discardDecision&&frame.hand?.complete&&!frame.hand.rejected?.length&&
       frame.own_melds?.complete&&pending.before.own_melds?.complete&&
       roundIdentity(frame)&&!changedRound(pending.before,frame)&&!frame.call_choices?.verified){
      const meldKey=f=>JSON.stringify(canonicalMelds(f,'self',f.own_melds));
      const sameMelds=meldKey(frame)===meldKey(pending.before);
      const hand=frame.hand.tiles.map(t=>t.tile),old=pending.decision.visibleHand;
      const same=(a,b)=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
      const drawn=hand.length===14-3*frame.own_melds.groups.length&&same(hand.slice(0,-1),old);
      const waiting=hand.length===13-3*frame.own_melds.groups.length&&same(hand,old);
      const beforeWall=pending.before.round?.remaining?.value,wall=frame.round?.remaining?.value;
      const advanced=Number.isInteger(beforeWall)&&Number.isInteger(wall)&&wall<beforeWall;
      const claimed=overriddenCall(pending.decision,pending.before,frame);
      if(sameMelds&&(drawn||(waiting&&(claimed||(advanced&&!sameReactionWindow(pending.before,frame)))))){
        await session.dismissUnexecutedCall();
        this.adapter.call=null;this.special=null;this.consumed=[];
        this.publicFrame=pending.before;
        // Selection brightness was requested only for the obsolete call.
        delete frame.selection;
        await this.record({kind:'unexecuted_call_closed',frame:frame.id,action,reason,claimed});
        return this.stepOnce(frame);
      }
    }
    if(onlyCallCheck)return null;
    // A closed PASS window has no concealed-hand effect to reconstruct.
    // A complete current hand is authoritative even when the old hand was
    // misread. Commit the ended response, then synchronize on this same frame.
    if(pending===this.pending&&action==='PASS'&&session.pending?.ledger&&session.pending?.output?.response==='PASS'&&
       !frame.controls?.PASS&&frame.hand?.complete&&!frame.hand.rejected?.length&&frame.own_melds?.complete&&
       roundIdentity(frame)&&!changedRound(pending.before,frame)&&
       !frame.selection?.verified&&!frame.call_choices?.verified&&
       [13,14].includes(frame.hand.tiles.length+3*frame.own_melds.groups.length)){
      await session.confirm('PASS');
      this.pending=null;
      if(pending.publicMode)this.publicFrame=pending.before;
      await this.record({kind:'pass_window_closed',frame:frame.id,reason});
      return this.stepOnce(frame);
    }
    if(pending===this.pending&&action?.startsWith('PLAY ')&&session.pending?.ledger&&session.pending.output.response===action){
      let next=null;
      try{
        const ledger=applyPublicEvent(session.pending.ledger,{state:`3 ${session.seat} ${action}`});
        next=currentDecision({ledger,pending:null},pending.before,frame);
      }catch{}
      const sameHand=JSON.stringify(frame.hand?.tiles.map(t=>t.tile).sort())===JSON.stringify([...(pending.decision.visibleHand??[])].sort());
      if(next&&!sameHand){
        // Exact removal of the submitted tile plus a distinct new draw proves
        // completion even if an old river cannot be read. Continue on this
        // very frame instead of holding the old transaction forever.
        await session.confirm(action);
        this.anchor={decision:pending.decision,before:pending.before};
        this.pending=null;this.publicFrame=null;this.consumed=[];
        await this.record({kind:'discard_confirmed_by_next_hand',frame:frame.id,action,reason});
        return this.stepOnce(frame);
      }
    }
    pending.firstUnconfirmedAt??=performance.now();
    if(performance.now()-pending.firstUnconfirmedAt<1200)return {status:pending.decision?.output?.response?.startsWith('PLAY ')?'waiting_discard_effect':'waiting_pass_frame',reason};
    // An unconfirmed own action is not permission to replace its history.
    // Keep both transaction and committed prefix until fresh evidence resolves it.
    return this.waitForEvidence(frame,reason);
  }

  async step(){
    try{
      const result=await this.stepOnce();
      if(['input_sent','observing','pass_confirmed','recovered_current_turn'].includes(result.status))this.handConflictRetries=0;
      return result;
    }catch(error){
      if(!['VISIBLE_HAND_CONFLICT','COMMITTED_PREFIX_CONFLICT'].includes(error.code))throw error;
      const frame=this.frame;
      if(frame&&await this.repairIdleHistory(this.rawFrame?.id===frame.id?this.rawFrame:frame,error.message))return {status:'history_repaired',frame:frame.id};
      if(!this.session.pending&&typeof this.session.reconcileVisibleHand==='function'&&
         frame?.hand?.complete&&!frame.hand.rejected?.length&&frame.own_melds?.complete&&
         frame.hand.tiles.length===14-3*frame.own_melds.groups.length&&
         !frame.selection?.verified&&!frame.call_choices?.verified){
        this.session.reconcileVisibleHand(frame.hand.tiles.map(t=>t.tile).slice(0,-1),{frameId:frame.id});
        // One same-frame current-state pass; no recursive historical retry.
        this.currentOnly=true;
        try{return await this.stepOnce(frame);}finally{this.currentOnly=false;}
      }
      // observeVerified validates atomically; the decision path also rolls
      // back its public prefix. Preserve committed history and any sent input.
      // First reacquire normally. Only a repeated conflict permits snapshot
      // recovery on the NEXT fresh frame, never on this contradictory image.
      this.handConflictRetries=(this.handConflictRetries??0)+1;
      await this.record({kind:error.code==='COMMITTED_PREFIX_CONFLICT'?'committed_prefix_conflict':'hand_history_conflict',frame:this.frame?.id,reason:error.message,committed:error.committed,observed:error.observed,retry:this.handConflictRetries,recoveryOnFreshFrame:false});
      return {status:'retry_fresh_observation',reason:error.message};
    }
  }
  async stepOnce(readyFrame=null){
    let start=performance.now();const adapter=this.adapter,session=this.session;
    if(this.terminal)return {status:'hand_ended',...this.terminal};
    if(this.win){
      const frame=await adapter.inspect({meld_count:this.win.before.hand.meld_count??0,phase:'auto',auto_meld_count:true,observeSettlement:true});
      if(frame.terminal_phase?.name==='match_end')return {status:'match_ended',frame:frame.id};
      const boundary=changedRound(this.win.before,frame);
      if(boundary)return {status:'round_boundary',frame:frame.id,...boundary,pendingAction:'HU'};
      let proof;
      try{proof=verifyWinSettlement(this.win.decision,this.win.before,frame);}
      catch(error){
        this.win.candidate=null;
        if(performance.now()-(this.win.sentAt??this.win.started)>=1200&&roundIdentity(frame)&&!frame.settlement?.complete)
          return this.recoverTransaction(frame,error.message,this.win);
        return {status:'waiting_win_settlement',reason:error.message};
      }
      const signature=JSON.stringify(proof.scores);
      if(this.win.candidate?.signature!==signature||this.win.candidate.id===frame.id){
        this.win.candidate={signature,id:frame.id,capturedAt:frame.capturedAt};return {status:'waiting_stable_win_settlement'};
      }
      if(!Number.isFinite(frame.capturedAt)||!Number.isFinite(this.win.candidate.capturedAt)||frame.capturedAt-this.win.candidate.capturedAt<SETTLEMENT_STABLE_MS)return {status:'waiting_stable_win_settlement'};
      adapter.confirmWinSettlement(this.win.before,frame);
      await session.confirm('HU');
      this.terminal={proof,confirmationMs:performance.now()-this.win.started};
      await this.record({kind:'win_confirmation',...this.terminal});
      this.win=null;return {status:'hand_ended',...this.terminal};
    }
    if(this.special){
      const result=await advanceStaged(adapter,session,this.special);
      const ron=callOverriddenByRon(this.special,this.special.latest??{});
      if(ron){
        const current=this.special.latest,action=this.special.decision.output.response;
        await session.dismissUnexecutedCall();this.adapter.call=null;this.special=null;
        await this.record({kind:'unexecuted_call_closed',frame:current.id,action,claimed:ron});
        return this.stepOnce(current);
      }
      if(result.status==='waiting_special_settlement')return result;
      // Staged confirmation must not mute independently visible public events.
      if(this.special.latest){
        const fresh=this.visibleLog.observe(this.special.latest);
        if(fresh.length)await this.record({kind:'visible_public_events',frame:this.special.latest.id,requests:fresh,source:'staged-visible-position-diff'});
      }
      if(result.status.startsWith('waiting_')&&performance.now()-this.special.started>1200){
        let current=(this.special.latest?.hand?.complete?this.special.latest:null)??await adapter.inspect({meld_count:this.special.before.hand.meld_count??0,phase:'auto',auto_meld_count:true,observeSettlement:true});
        current=recoverOwnKong(this.special,current);
        if(['CHI','PENG'].includes(this.special.decision.output.response.split(' ')[0])&&!this.special.discardDecision){
          const oldSpecial=this.special;
          const recovered=await this.recoverTransaction(current,'核对旧吃碰是否实际执行',oldSpecial,{onlyCallCheck:true});
          if(this.special!==oldSpecial)return recovered;
        }
        if(this.special.discardDecision&&discardLeftHand(this.special.discardDecision,
          this.special.decision.output.response.startsWith('LIZHI ')?this.special.before:this.special.discardBefore,current)){
          // The local hand proves the discard. River/deposit confirmation may
          // lag, but must not prevent enabling the independently observed toggle.
          if(await this.updateAutoWin(current))return {status:'auto_win_sent',frame:current.id};
          return {status:'waiting_discard_river',frame:current.id};
        }
        const oldRemaining=this.special.before.round?.remaining?.value,newRemaining=current.round?.remaining?.value;
        const progressed=Number.isInteger(oldRemaining)&&Number.isInteger(newRemaining)&&newRemaining<oldRemaining;
        const reaction=current.controls?.HU||current.controls?.RONG||current.controls?.TSUMO||current.controls?.PASS;
        if((progressed||reaction)&&
           current.hand?.complete&&current.own_melds?.complete&&!changedRound(this.special.before,current)){
          if(!current.call_choices?.verified&&!current.selection?.verified){
            this.special.firstUnconfirmedAt??=this.special.started;
            return this.recoverTransaction(current,'牌山已推进，旧操作结果未确认，按当前局面重新决策',this.special);
          }
        }
      }
      if(result.status==='kong_confirmed'){
        this.kongDraw=result;this.consumed=[];this.publicFrame=null;this.special=null;
        await this.record({kind:'kong_confirmation',action:result.decision.output.response,before:result.before.id,after:result.frame.id,draw:result.request});
        return {status:'kong_draw_ready'};
      }
      if(result.status==='special_confirmed'){
        this.anchor=result.anchor;this.consumed=[];this.publicFrame=null;
        await this.record({kind:'confirmation',action:this.special.decision.output.response,before:this.special.before.id,after:result.frame,confirmationMs:result.totalMs,riverTracking:result.riverTracking});
        const current=this.special.latest;this.special=null;
        if(result.nextDraw){delete current.selection;return this.stepOnce(current);}
      }else if(['special_discard_sent','special_choice_sent'].includes(result.status))await this.record({kind:'staged_input',action:this.special.decision.output.response,...result,withinBudget:result.totalMs<=5000});
      else if(result.status==='special_button_retried')await this.record({kind:'verified_unchanged_riichi_retry',...result,withinBudget:false});
      else if(result.status==='unresolved_special_effect')await this.record({kind:'unresolved',...result});
      return result;
    }
    // After a kong draw is submitted, kongDraw is cleared but its discard is
    // still pending. Keep that post-kong layout until confirmation updates the
    // anchor; reverting to the pre-kong anchor makes every later hand incomplete.
    const inspectOptions={meld_count:this.pending?.before.hand.meld_count??this.kongDraw?.frame.hand.meld_count??this.publicFrame?.hand.meld_count??this.anchor.before.hand.meld_count,auto_meld_count:true,phase:'auto',observeSettlement:true,fast_rivers:typeof adapter.refineRivers==='function'};
    let raw=readyFrame??await adapter.inspect(inspectOptions);
    this.rawFrame=raw;
    if(this.recoveredKong)raw=recoverOwnKong(this.recoveredKong,raw);
    if(!this.riverObservations){this.riverObservations=new RiverObservationCache();this.riverObservations.apply(this.anchor.before);}
    const conflicts=this.riverObservations.conflicts(raw);
    if(conflicts.length){
      // Old immutable identities are retained by the cache below. An old
      // face disagreement must not put another capture on the decision path.
      await this.record({kind:'recognition_conflict_retained',frame:raw.id,conflicts});
    }
    if(raw.terminal_phase?.name==='match_end')return {status:'match_ended',frame:raw.id,pendingAction:session.pending?.output?.response??null};
    if(raw.settlement?.complete){
      const signature=JSON.stringify(Object.fromEntries(Object.entries(raw.settlement.scores).map(([p,s])=>[p,s.value])));
      if(this.lastSettlementSignature!==signature){
        await this.record({kind:'settlement_observation',frame:raw.id,scores:raw.settlement.scores,confirmed:false});
        this.lastSettlementSignature=signature;
      }
      if(!this.pending&&!session.pending){
        try{
          this.passiveScores??=new SettlementCollector();
          this.passiveScores.observe(raw,this.anchor.before.round.seat_identity.seats);
          this.passiveCandidate=this.passiveScores.candidate;
        }catch{this.passiveCandidate=null;}
        this.passiveSettlementFrame=raw;
      }
      return {status:'observing_settlement',frame:raw.id};
    }
    // Result overlays hide the wind/hand/counters. They are not a playable
    // table and must not enter meld/event inference or its failure timeout.
    if(!roundIdentity(raw))return {status:'waiting_round_frame',frame:raw.id};
    const boundary=changedRound(this.anchor.before,raw);
    if(boundary){
      if(this.passiveCandidate&&!this.pending&&!session.pending){
        await this.record({kind:'settlement_candidate',candidate:this.passiveCandidate,nextFrame:raw.id});
        return {status:'hand_ended',proof:this.passiveCandidate};
      }
      await this.record({kind:'round_boundary',frame:raw.id,...boundary,pendingAction:this.pending?.decision.output.response??null});
      return {status:'round_boundary',frame:raw.id,...boundary};
    }
    this.passiveSettlementFrame=null;this.passiveCandidate=null;
    const riichiAutoPlay=this.passiveRiichi(raw);
    // Auto-win skips the HU button entirely. Do not request a discard during
    // its animation, including frames where the concealed tiles are obscured.
    if(raw.result_page?.kind==='own-win-settlement')return {status:'observing_settlement',frame:raw.id};
    if(!riichiAutoPlay&&awaitingTsumoControl(raw)){
      if(raw.auto_win?.verified&&raw.auto_win.enabled||adapter.autoWinOutput?.confirmed)this.autoWinAnimation=true;
      return {status:this.autoWinAnimation?'waiting_auto_win_settlement':'waiting_tsumo_control',frame:raw.id};
    }
    if(!riichiAutoPlay&&this.autoWinAnimation){
      if(!raw.hand?.complete)return {status:'waiting_auto_win_settlement',frame:raw.id};
      this.autoWinAnimation=false;
    }
    if(Number.isFinite(raw.captureStartedMono))start=Math.min(start,raw.captureStartedMono);
    if(!this.riverObservations){this.riverObservations=new RiverObservationCache();this.riverObservations.apply(this.anchor.before);}
    completeDecodedRivers(raw);
    let cached=this.riverObservations.apply(raw);
    let frame=trackOccludedRivers(this.pending?.before??this.kongDraw?.frame??this.publicFrame??this.anchor.before,cached);
    // Do not spend another recognition pass on identical, possibly occluded
    // pixels. Publish confirmed events now; the next fresh frame repairs gaps.
    const tracked=Object.entries(frame.rivers??{}).flatMap(([position,r])=>(r.tiles??[]).filter(t=>t.tracking).map(t=>({position,tile:t.tile,center:t.center,source:t.tracking.source})));
    const trackingSignature=JSON.stringify(tracked);
    if(tracked.length&&trackingSignature!==this.lastTrackingSignature)
      await this.record({kind:'river_tracking',frame:frame.id,tracked,freshRecognition:false});
    this.lastTrackingSignature=trackingSignature;
    this.frame=frame;session.discardObservation=frame;
    session.opponentHandConstraints=frame.opponent_hand_constraints;
    if(!this.meldObservations){this.meldObservations=new MeldObservationCache();this.meldObservations.apply(this.anchor.before);}
    frame=this.meldObservations.apply(frame);this.frame=frame;
    if(!this.callRiverPlayers)this.observeCallRivers(this.anchor.before);
    this.observeCallRivers(frame);
    const recentObservation=this.lastDecisionObservation;
    this.lastDecisionObservation=structuredClone(frame);
    this.reactionObservations??=new ReactionObservationCache();
    const reactionEvidence=this.reactionObservations.observe(frame)??newDiscardEvidence(recentObservation,frame);
    if(reactionEvidence)this.reactionEvidence=reactionEvidence;
    else if((recentObservation?.controls?.PASS&&!frame.controls?.PASS)||
      frame.hand?.tiles?.length===14-3*(frame.own_melds?.groups?.length??0)||
      JSON.stringify(this.reactionEvidence?.round)!==JSON.stringify(roundIdentity(frame)))this.reactionEvidence=null;
    this.independentDisplay=true;
    const visibleRequests=this.visibleLog.observe(frame,{includeSelf:riichiAutoPlay});
    if(visibleRequests.length)await this.record({kind:'visible_public_events',frame:frame.id,requests:visibleRequests,source:'visible-position-diff'});
    if(riichiAutoPlay){this.publicFrame=structuredClone(frame);return {status:'riichi_auto_play',frame:frame.id};}
    if(await this.onVisibleFrame?.(frame)===true)return {status:'retry_fresh_observation',reason:'可选界面操作已消耗本帧，重新获取画面'};
    if(this.outputRecovery){
      const result=await this.recoverTransaction(frame,this.outputRecovery.reason,this.outputRecovery);
      if(result.status==='recovered_current_turn')this.outputRecovery=null;
      return result;
    }
    if(this.pending){
      const p=this.pending;
      // Handle a visibly ineffective ordinary click before any history/call
      // reconstruction. Unrelated river/meld OCR cannot veto local proof.
      const inputFrame=p.inputFrame??p.before;
      const stableFrame=p.lastRetryObservation;
      p.lastRetryObservation=structuredClone(raw);
      if(unchangedDiscard(p.decision,inputFrame,raw,{localOnly:true,stableFrame})){
        const fresh=raw.id!==p.lastRetryFrame&&(!p.lastRetryAt||!Number.isFinite(raw.captureStartedMono)||raw.captureStartedMono>=p.lastRetryAt);
        if(fresh&&(!p.lastRetryAt||performance.now()-p.lastRetryAt>=800)){
          const retryStarted=performance.now();
          const receipt=await adapter.execute({...p.decision,observationId:raw.id},raw);
          p.lastRetryAt=performance.now();p.lastRetryFrame=raw.id;p.firstUnconfirmedAt=p.lastRetryAt;
          p.discardRetryCount=(p.discardRetryCount??0)+1;
          await this.record({kind:'verified_unchanged_discard_retry',action:p.decision.output.response,before:inputFrame.id,after:raw.id,receipt,retryCount:p.discardRetryCount,operationMs:performance.now()-retryStarted,totalMs:performance.now()-p.started,withinBudget:performance.now()-p.started<=5000});
          return {status:'discard_retry_sent'};
        }
        return {status:'waiting_discard_effect'};
      }
      if(p.decision.output.response==='PASS'){
        if(!frame.hand?.complete)return {status:'waiting_pass_frame'};
        if(frame.controls?.PASS){
          // A later player's discard can open another reaction window before
          // our next capture. Prove public progression, not button absence.
          // A directly observed new discard proves that the previous PASS
          // window has ended, independently of unrelated missing history.
          const freshReaction=newDiscardEvidence(p.before,frame);
          let progressed=!!freshReaction;
          if(freshReaction)this.reactionEvidence=freshReaction;
          try{
            if(p.publicMode){
              const delta=publicContinuation(p.before,frame,session);
              progressed=progressed||delta.requests.length>0||delta.pendingCall===true;
            }else{
              const delta=ordinarySpan(this.anchor.decision,this.anchor.before,frame);
              progressed=progressed||(this.consumed.every((state,i)=>delta.requests[i]?.state===state)&&delta.requests.length>this.consumed.length);
            }
          }catch{}
          if(!progressed){
            p.firstUnconfirmedAt??=performance.now();
            if(performance.now()-(p.lastRetryAt??p.started)<800)return {status:'waiting_pass_effect'};
            if(raw.id!==p.lastRetryFrame&&sameReactionWindow(p.before,raw)&&
               (!Number.isFinite(raw.captureStartedMono)||raw.captureStartedMono>=(p.lastRetryAt??p.started))){
              const receipt=await adapter.pass({...p.decision,observationId:raw.id},raw);
              p.lastRetryAt=performance.now();p.lastRetryFrame=raw.id;
              p.effectRetryCount=(p.effectRetryCount??0)+1;
              await this.record({kind:'verified_unchanged_pass_retry',before:p.before.id,after:raw.id,receipt,retryCount:p.effectRetryCount});
              return {status:'pass_retry_sent'};
            }
            return this.recoverPass(frame,'PASS 后无法确认历史推进，按当前可见局面恢复');
          }
        }
        let visible=frame.hand.tiles.map(t=>t.tile);
        // A skipped reaction can already be followed by our next draw. The
        // whole ordinary prefix must prove that draw before removing it here.
        if(visible.length===p.decision.visibleHand.length+1){
          let span;
          try{span=p.publicMode?publicContinuation(p.before,frame,session):ordinarySpan(this.anchor.decision,this.anchor.before,frame);}
          catch(error){
            // PASS cannot change our hand. Its accepted ledger plus a single
            // visible draw is enough; unrelated old river OCR must not hold
            // this transaction open and block the new decision.
            span=currentDecision({pending:null,ledger:session.pending?.ledger},p.before,frame);
            if(!span)return this.recoverPass(frame,error.message);
          }
          const nextDraw=span.nextDraw??(/^2 (\S+)$/.exec(span.requests?.at(-1)?.state??'')?.[1]);
          if(!nextDraw||visible.at(-1)!==nextDraw)return this.recoverPass(frame,'PASS 后手牌或摸牌与历史不一致');
          visible.pop();
        }
        if(!frame.hand.complete||visible.sort().join(' ')!==p.decision.visibleHand.slice().sort().join(' '))
          return this.recoverPass(frame,'PASS 后手牌或摸牌与历史不一致');
      }else{
        try{
          try{verifyDiscard(p.decision,p.before,frame);}
          catch(discardError){
            try{try{verifyLocalDiscard(p.decision,p.before,frame);}catch{try{verifyCalledDiscard(p.decision,p.before,frame);}catch{chainedCallSpan(p.decision,p.before,frame);}}}
            catch(callError){throw Error(`${discardError.message}; call alternative: ${callError.message}`);}
          }
        }
        catch(error){
          const replacement=replacedDiscard(p.decision,p.before,frame);
          if(replacement){
            // The input event/ledger is still valid; only its resulting action
            // differs. Keep all earlier requests and commit the observed tile.
            p.decision=replacement.decision;
            session.pending={...session.pending,output:{...session.pending.output,response:replacement.actual}};
            await this.record({kind:'default_action_replacement',frame:frame.id,requested:replacement.requested,actual:replacement.actual});
          }else{
          if(discardLeftHand(p.decision,p.before,raw)){
            if(raw.hand?.complete&&raw.own_melds?.complete&&raw.hand.tiles.length===14-3*raw.own_melds.groups.length)
              return this.recoverTransaction(frame,error.message,p);
            if(await this.updateAutoWin(raw))return {status:'auto_win_sent',frame:raw.id};
            return {status:'waiting_discard_river',frame:raw.id};
          }
          p.firstUnconfirmedAt??=performance.now();
          const retryReady=performance.now()-(p.lastRetryAt??p.sentAt??p.started)>=800&&
            raw.id!==p.lastRetryFrame&&(!p.lastRetryAt||!Number.isFinite(raw.captureStartedMono)||raw.captureStartedMono>=p.lastRetryAt);
          if(retryReady&&unchangedDiscard(p.decision,p.before,raw,{ownPrompt:true})){
            const receipt=await adapter.pass({...p.decision,output:{response:'PASS'},observationId:raw.id},raw);
            p.promptDismissed=true;
            p.lastRetryAt=performance.now();p.lastRetryFrame=raw.id;p.firstUnconfirmedAt=p.lastRetryAt;
            p.promptRetryCount=(p.promptRetryCount??0)+1;
            await this.record({kind:'discard_prompt_dismissed',action:p.decision.output.response,frame:raw.id,receipt,retryCount:p.promptRetryCount});
            return {status:'waiting_discard_prompt_close'};
          }
          const retryBefore=p.promptDismissed?{...p.before,controls:{}}:p.before;
          if(retryReady&&unchangedDiscard(p.decision,retryBefore,raw)){
            const retryStarted=performance.now();
            const receipt=await adapter.execute({...p.decision,observationId:raw.id},raw);
            p.lastRetryAt=performance.now();p.lastRetryFrame=raw.id;p.firstUnconfirmedAt=p.lastRetryAt;
            p.discardRetryCount=(p.discardRetryCount??0)+1;
            const totalMs=performance.now()-p.started;
            await this.record({kind:'verified_unchanged_discard_retry',action:p.decision.output.response,before:p.before.id,after:raw.id,receipt,retryCount:p.discardRetryCount,operationMs:performance.now()-retryStarted,totalMs,withinBudget:totalMs<=5000});
            return {status:'discard_retry_sent'};
          }
          if(unchangedDiscard(p.decision,retryBefore,raw)||unchangedDiscard(p.decision,p.before,raw,{ownPrompt:true}))return {status:'waiting_discard_effect'};
          return this.recoverTransaction(frame,error.message,p);
          }
        }
      }
      await session.confirm(p.decision.output.response);
      await this.record({kind:'confirmation',action:p.decision.output.response,before:p.before.id,after:frame.id,confirmationMs:performance.now()-p.started});
      if(p.decision.output.response!=='PASS'){this.anchor={decision:p.decision,before:repairAnchorEvidence(p.before,frame)};this.consumed=[];this.publicFrame=null;}
      else if(p.publicMode)this.publicFrame=p.before;
      this.pending=null;
    }
    if(!this.special&&!this.win&&!this.adapter.call&&await this.updateAutoWin(frame)){
      return {status:'auto_win_sent'};
    }
    if(this.passiveRiichi(frame))return {status:'riichi_auto_play',frame:frame.id};
    // Animated hands can cover an otherwise unchanged meld band. Missing
    // visual evidence is not a contradictory event history: wait for a fresh
    // complete frame within the run's existing bound, without issuing input.
    if(!frame.hand?.complete||frame.hand.rejected?.length||!frame.own_melds?.complete)
      return this.waitForEvidence(frame,'手牌、副露或牌河暂未识别完整');
    if(conflicts.length&&await this.repairIdleHistory(raw,'连续完整画面与旧牌河记录冲突'))return {status:'history_repaired',frame:frame.id};
    let handSynchronized=false;
    if(!session.pending&&session.ledger?.hand&&typeof session.reconcileVisibleHand==='function'&&!frame.hand.rejected?.length&&
       roundIdentity(frame)&&!changedRound(this.anchor.before,frame)&&!frame.selection?.verified&&!frame.call_choices?.verified){
      const visible=frame.hand.tiles.map(t=>t.tile),base=13-3*frame.own_melds.groups.length;
      if([base,base+1].includes(visible.length)){
        const expected=visible.length===base+1?visible.slice(0,-1):visible;
        if(session.reconcileVisibleHand(expected,{frameId:frame.id})){
          handSynchronized=true;
          await this.record({kind:'visible_hand_synchronized',frame:frame.id,hand:expected,historyPreserved:true});
        }
      }
    }
    let span,publicMode=!!this.publicFrame;
    if(this.publicFrame)this.publicFrame=repairAnchorEvidence(this.publicFrame,frame);
    if(this.anchor?.before)this.anchor.before=repairAnchorEvidence(this.anchor.before,frame);
    const visibleTurn=frame.hand.tiles.length===14-3*frame.own_melds.groups.length&&!this.kongDraw&&!this.opening&&!this.snapshotEvent
      ?currentDecision(session,this.publicFrame??this.anchor.before,frame,recentObservation,{consumed:publicMode?[]:this.consumed,publicMode}):null;
    try{

      if(!frame.own_melds?.complete)throw Error('Incomplete own meld observation');
      if((handSynchronized||this.currentOnly)&&visibleTurn){
        span=this.currentOnly?{...visibleTurn,requests:visibleTurn.requests.slice(-1)}:visibleTurn;
        publicMode=true;this.opening=null;this.openingConsumed=[];
        if(!span)return this.waitForEvidence(frame,'当前操作信息未完整识别');
      }
      else if(this.snapshotEvent){span={requests:[this.snapshotEvent]};publicMode=true;}
      else if(this.opening){
        try{span=openingPrefix(frame,{allowPending:true});}
        catch(error){
         if(error.code!=='OPENING_PASSED'||!this.publicFrame)throw error;
         span=publicContinuation(this.publicFrame,frame,session);this.opening=null;
        }
        publicMode=true;
        if(this.opening){
        if(JSON.stringify(span.hand)!==JSON.stringify(this.opening.hand)||span.indicator!==this.opening.indicator)throw Error('Opening changed before decision');
        if((this.openingConsumed??[]).some((state,i)=>span.requests[i]?.state!==state))throw Error('Committed opening prefix changed');
        }
      }else if(this.kongDraw){
        const verified=verifyKongDraw(this.kongDraw.decision,this.kongDraw.before,frame,{localOnly:true});
        span={verified:true,requests:[verified.request]};
      }else if(publicMode){
        span=publicContinuation(this.publicFrame,frame,session);
      }else{
        try{
          try{span=ordinarySpan(this.anchor.decision,this.anchor.before,frame);}
          catch(error){if(!declaredSeats(session.requests).has(session.seat)&&!this.anchor.decision.output.response.startsWith('LIZHI ')&&!this.anchor.before.rivers?.self?.tiles.some(t=>t.sideways===true))throw error;span=riichiSpan(this.anchor.decision,this.anchor.before,frame);}
        }
        catch(original){
          const changes=[];
          for(const position of ['right','opposite','left']){
            const old=canonicalMelds(this.anchor.before,position,this.anchor.before.opponent_melds?.[position]);
            const next=canonicalMelds(frame,position,frame.opponent_melds?.[position]);
            if(JSON.stringify(old)!==JSON.stringify(next))changes.push({actor:position,oldMelds:old,newMelds:next});
          }
          try{
            if(changes.length!==1)throw original;
            try{span=callAfterDiscard(this.anchor.decision,this.anchor.before,frame,changes[0]);}
            catch{span=callSpan(this.anchor.decision,this.anchor.before,frame,changes[0]);}
          }catch{
            if(!changes.length)throw original;
            try{span=chainedCallSpan(this.anchor.decision,this.anchor.before,frame);}
            catch(error){throw Error(`${original.message}; call recovery: ${error.message}`);}
          }
          if(this.consumed.some((state,i)=>span.requests[i]?.state!==state))
            throw Error('Committed call prefix changed');
          span={...span,requests:span.requests.slice(this.consumed.length)};
          publicMode=true;
        }
      }
      if(!publicMode&&this.consumed.some((state,i)=>span.requests[i]?.state!==state))
       throw Object.assign(Error('Committed cycle prefix changed'),{code:'COMMITTED_PREFIX_CONFLICT',committed:[...this.consumed],observed:span.requests.map(r=>r.state)});
      // Keep readable incremental events, but never let an incomplete/empty
      // historical span hide a fully recognized current own turn.
      if(visibleTurn&&(span.pendingCall||!span.requests?.at(-1)?.state?.startsWith('2 '))){
        span=visibleTurn;publicMode=true;this.opening=null;this.openingConsumed=[];
      }
      if(span.pendingCall){
        const current=currentDecision(session,this.publicFrame??this.anchor.before,frame,recentObservation,{consumed:publicMode?[]:this.consumed,publicMode,reactionEvidence:this.reactionEvidence});
        if(!current)return {status:'observing',pendingOpponentCall:true};
        span=current;publicMode=true;this.opening=null;this.openingConsumed=[];
      }
      const outstanding=this.opening?span.requests.slice((this.openingConsumed??[]).length):publicMode?span.requests:span.requests.slice(this.consumed.length);
      // Delayed controls are independent of the history path (including the
      // opening prefix). Reuse the committed event rather than rebuilding it.
      if(frame.controls?.PASS&&!outstanding.length){
        const event=session.requests?.at(-1);
        const key=`${session.requests?.length}:${event?.state}`;
        if(this.lastReactionKey===key)return {status:'observing'};
        if(/^3 [0-3] (PLAY|LIZHI|CHI|PENG|BUGANG) /.test(event?.state??'')){
          span={requests:[event],reuseObserved:true};publicMode=true;
          this.opening=null;this.openingConsumed=[];this.consumed=[];
          this.publicFrame=frame;
        }
      }
      if(!span.reuseObserved&&frame.controls?.PASS&&!/^3 [0-3] (PLAY|LIZHI|CHI|PENG|BUGANG) /.test(outstanding.at(-1)?.state??'')&&!outstanding.at(-1)?.state?.startsWith('2 '))
       throw Error('Visible reaction requires decision despite unchanged event prefix');
    }catch(error){
      span=currentDecision(session,this.publicFrame??this.anchor.before,frame,recentObservation,{consumed:publicMode?[]:this.consumed,publicMode,reactionEvidence:this.reactionEvidence});
      if(!span){
       if(error.code==='COMMITTED_PREFIX_CONFLICT')throw error;
       return this.waitForEvidence(frame,error.message);
      }
      publicMode=true;
      this.opening=null;this.openingConsumed=[];
      await this.record({kind:'current_hand_decision',frame:frame.id,reason:error.message,requests:span.requests,historyPreserved:true});
    }

    if(this.recoveringEvidence){await this.record({kind:'evidence_recovered',frame:frame.id});this.recoveringEvidence=false;}
    this.unresolvedSince=null;
    if(span.estimated){
      span.requests=span.requests.map(q=>({...q,historyOrderCertain:false}));
      session.estimatedHistory={frameId:frame.id,assumptions:span.assumptions};
      await this.record({kind:'history_order_estimate',frame:frame.id,assumptions:span.assumptions,requests:span.requests});
    }
    const all=span.requests;
    const remaining=this.opening?all.slice((this.openingConsumed??[]).length):publicMode?all:all.slice(this.consumed.length);
    if(!remaining.length)return {status:'observing'};
    if(!span.reuseObserved)await this.reportVisibleEvents({...span,requests:remaining},frame,publicMode);
    const event=remaining.at(-1),own=event.state.startsWith('2 ');
    if(span.reuseObserved&&this.lastReactionKey===`${session.requests?.length}:${event.state}`)return {status:'observing'};
    const reaction=!!frame.controls?.PASS&&/^3 [0-3] (PLAY|LIZHI|CHI|PENG|BUGANG) /.test(event.state);
    if(!own&&!reaction){
      if(publicMode){session.observeVerified({verified:true,requests:remaining},frame.hand.tiles.map(t=>t.tile));this.snapshotEvent=null;if(this.opening)this.openingConsumed=all.map(r=>r.state);this.publicFrame=frame;this.consumed=[];await this.record({kind:'public_events',frame:frame.id,requests:remaining});}
      return {status:'observing'};
    }
    const melds=canonicalMelds(frame,'self',frame.own_melds);
    const request=visibleActions(frame,event,melds);
    const previous=remaining.slice(0,-1);
    // One atomic public prefix before the decision; own draw is applied only
    // by decide(), never appended a second time by the observation loop.
    const expected=frame.hand.tiles.map(t=>t.tile);
    if(own)expected.pop();
    const checkpoint={requests:session.requests?.slice(),responses:session.responses?.slice(),ledger:structuredClone(session.ledger)};
    let decision,recognized;
    try{
      session.observeVerified({verified:true,requests:previous},expected);
      recognized=performance.now();
      decision=await session.decide(request,frame.hand.tiles.map(t=>t.tile),{reuseObserved:!!span.reuseObserved});
    }catch(error){
      // No mouse input has been issued. Retrying a failed calculation must
      // not append the same observed public prefix again.
      if(!session.pending)Object.assign(session,checkpoint);
      if(error.code==='BOT_INVALID_RESULT'){
        // The checkpoint above preserves the verified history for a fresh retry.
        await this.record({kind:'invalid_bot_result',frame:frame.id,reason:error.message});
        return {status:'retry_fresh_observation'};
      }
      throw error;
    }
    decision.observationId=frame.id;
    const decided=performance.now();
    const metadata={verified:true,observationId:frame.id,seats:frame.round.seat_identity.seats,melds,lastDiscarder:session.pending.ledger.lastPlayer,
      lastDiscard:{tile:session.pending.ledger.lastDiscard,seat:session.pending.ledger.lastPlayer}};
    let receipt;
    try{receipt=await adapter.execute(decision,raw,metadata);}catch(error){
      if((error.inputNotSent||error.outputOutcomeUnknown)&&
         (decision.output.response.startsWith('PLAY ')||(error.outputOutcomeUnknown&&decision.output.response==='PASS'))){
        // Keep the chosen discard and its ledger. The next fresh frame can
        // confirm an effect or retry this exact action, without reconstruction.
        this.pending={decision,before:frame,inputFrame:structuredClone(raw),started:start,publicMode,sentAt:performance.now()};
        this.opening=null;this.snapshotEvent=null;this.consumed=all.map(r=>r.state);
        await this.record({kind:error.inputNotSent?'input_rejected_before_down':'input_outcome_unconfirmed',action:decision.output.response,reason:error.message});
        return {status:'retry_fresh_observation'};
      }
      if(error.outputOutcomeUnknown){
        const transaction={decision,before:frame,started:start,sentAt:performance.now(),riverObservations:this.riverObservations};
        if(decision.output.response==='HU')this.win=transaction;
        else this.special=transaction;
        this.opening=null;this.snapshotEvent=null;this.consumed=all.map(r=>r.state);
        await this.record({kind:'input_outcome_unconfirmed',action:decision.output.response,reason:error.message,stageRetained:true});
        return {status:'retry_fresh_observation'};
      }
      if(!error.inputNotSent)throw error;
      // Proven pre-down rejection: no game input happened. Roll back only
      // this decision, then obtain a fresh observation before trying again.
      session.pending=null;Object.assign(session,checkpoint);adapter.call=null;
      if(reaction){
        // The opponent's discard happened even though our click did not.
        // Commit that observation once, without committing the rejected call.
        // Fresh controls can still reopen this reaction through reuseObserved;
        // if the window expired, publicContinuation advances normally.
        if(!span.reuseObserved)session.observeVerified({verified:true,requests:remaining.map(r=>({...r,validact:null}))},frame.hand.tiles.map(t=>t.tile));
        this.snapshotEvent=null;this.opening=null;this.openingConsumed=[];
        this.publicFrame=frame;this.consumed=[];this.lastReactionKey=null;
      }
      await this.record({kind:'input_rejected_before_down',action:decision.output.response,reason:error.message});
      return {status:'retry_fresh_observation'};
    }
    const sent=performance.now();
    if(reaction)this.lastReactionKey=`${decision.input?.requests?.length??session.requests?.length}:${event.state}`;
    this.kongDraw=null;
    this.opening=null;
    this.snapshotEvent=null;
    this.consumed=all.map(r=>r.state);this.actions++;
    const kind=decision.output.response.split(' ')[0];
    await this.record({kind:'input',action:decision.output.response,frame:frame.id,...frame.timing,decisionMs:decided-recognized,operationMs:sent-decided,totalMs:sent-start,withinBudget:sent-start<=5000,receipt});
    if(!['PLAY','PASS'].includes(kind)){
      if(kind==='HU'){this.win={decision,before:frame,started:start,sentAt:sent};return {status:'win_sent'};}
      if(['LIZHI','CHI','PENG','GANG','ANGANG','BUGANG'].includes(kind)){this.special={decision,before:frame,started:start,riverObservations:this.riverObservations};return {status:'special_started',action:decision.output.response};}
      return {status:'special_pending',action:decision.output.response};
    }
    this.pending={decision,before:frame,inputFrame:structuredClone(raw),started:start,publicMode,sentAt:performance.now()};
    return {status:'input_sent',action:decision.output.response};
  }
  async run({milliseconds=45000,maxActions=6,signal}={}){
    const end=performance.now()+milliseconds,initial=this.actions;
    // Do not yield between the call/riichi button and its required discard.
    // A bounded grace period finishes the transaction without starting an
    // unrelated decision after the requested run boundary.
    while((performance.now()<end&&this.actions-initial<maxActions)||(this.special&&performance.now()<end+8000)||(this.win&&performance.now()<end+35000)){
      if(signal?.aborted)return {status:'stopped',pending:!!(this.pending||this.special||this.win)};
      let result;
      try{result=await this.step();this.transientFailure=null;}catch(error){
        if(error.outputOutcomeUnknown){
          const p=this.pending??this.special??this.win;
          if(this.pending){
            // PLAY/PASS already have a visual-confirmation path. An uncertain
            // retry receipt must not detach that transaction into a dead end.
            await this.record({kind:'input_outcome_unconfirmed',action:p.decision.output.response,reason:error.message});
          }
          else if(p){await this.record({kind:'input_outcome_unconfirmed',action:p.decision.output.response,reason:error.message,stageRetained:true});}
          else if(error.autoWinOutputPending){await this.record({kind:'auto_win_input_outcome_unconfirmed',reason:error.message});}
          else throw error;
        }
        if(!error.outputOutcomeUnknown&&!error.inputNotSent&&!/Recognition timeout|Bound game must be foreground and not minimized|Native capture timeout/.test(error.message))throw error;
        if(this.transientFailure!==error.message){await this.record({kind:'recoverable_runtime_wait',reason:error.message});this.transientFailure=error.message;}
        if(error.message!=='Recognition timeout')await delay(250);
        continue;
      }
      if(['unresolved','unresolved_pass_effect','unresolved_special_effect','unresolved_win_effect','hand_ended','match_ended','round_boundary','special_pending'].includes(result.status))return result;
    }
    return {status:'checkpoint',actions:this.actions-initial,pending:!!(this.pending||this.special)};
  }
}
