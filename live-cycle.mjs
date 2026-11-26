import {discardWaits} from './terminal-log.mjs';
import {waitHistory} from './wait-details.mjs';
import {GAME,remainingHands} from './game-rules.mjs';
import {AutoWin} from './auto-win.mjs';
import {AutoKita} from './auto-kita.mjs';
import {AutoWinGuard} from './auto-win-guard.mjs';
import {confirmedNorthStock} from './kita-evidence.mjs';
import {automaticNorthDraw,sameKitaOffer} from './auto-kita-effect.mjs';
import {declaredSeats,riichiEvents} from './confirmed-riichi.mjs';
import {appendEvidence} from './background-evidence.mjs';
import {currentDecision,newDiscardEvidence,ReactionObservationCache,promptDiscard,matchesCallButtons} from './current-decision.mjs';
import {applyPublicEvent} from './hand-ledger.mjs';
import {observedPon} from './observed-pon.mjs';
import {detectManualOwnAction,manualActionBaseFrame} from './manual-own-action.mjs';
import {observedOwnKitaDiscard} from './observed-own-kita.mjs';
import {kitaTransition} from './kita-events.mjs';
import {stalledKitaButton,verifiedNorthChain,isDamaTenpaiNorthDraw,damaNorthAction,tsumoButtonCenter} from './auto-kita-effect.mjs';
import {ordinarySpan} from './ordinary-span.mjs';
import {verifyDiscard,verifyLocalDiscard,verifyCalledDiscard,replacedDiscard,discardLeftHand} from './discard-verification.mjs';
import {visibleActions,riichiKongTile,riichiDecisionPrompt} from './visible-actions.mjs';
import {decisionPolicy} from './action-policy.mjs';
import {OwnDrawControlWindow,missingControlsForValidact,resolveOwnDrawExecution} from './draw-control-window.mjs';
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
import {sameReactionWindow,classifyPassWindow} from './reaction-window.mjs';
import {changedRound,roundIdentity,conflictingRound,AbnormalBoundaryTracker} from './round-boundary.mjs';
import {SettlementCollector} from './passive-settlement.mjs';
import {openingPrefix} from './opening-prefix.mjs';
import {unchangedDiscard} from './unchanged-discard.mjs';
import {sameRinshanDraw} from './tsumo-guard.mjs';
import {VisibleEventLog} from './visible-event-log.mjs';
import {recoverOwnKong} from './own-kong-recovery.mjs';
import {newObservedTail,reviseObservedTail,reviseOlderDiscard} from './observed-tail.mjs';
import {setTimeout as delay} from 'node:timers/promises';

import {isConcealedHandSorted} from './opening-integrity.mjs';
export {isConcealedHandSorted};

// A serial observation/decision/output pump. It yields at a round change,
// unaccounted public event, or staged special action, retaining exact state.
// No inferred hidden events or duplicate bot requests. A single retry requires independently verified absence of the input effect.
export class LiveCycle {
  constructor(adapter,session,{decision,before,evidence,boundaryOptions}){
    if(session.pending)throw Error('Start from a confirmed own discard');
    delete adapter.autoWinOutput;
    if(GAME.sanma)delete adapter.autoKitaOutput; // a new hand; a reconnect retains the existing pump
    this.adapter=adapter;this.session=session;this.anchor={decision,before};
    this.consumed=[];this.evidence=evidence;this.actions=0;
    this.drawControlWindow=new OwnDrawControlWindow();
    this.autoWinGuard=new AutoWinGuard();
    this.boundaryTracker=new AbnormalBoundaryTracker(boundaryOptions);
    this.visibleLog=new VisibleEventLog(before);
    for(const [p,s] of Object.entries(before.round?.seat_identity?.seats??{}))if(this.visibleLog.players[p]&&declaredSeats(session.requests).has(s))this.visibleLog.players[p].declared=true;
  }
  async record(entry){appendEvidence(this.evidence,JSON.stringify({at:new Date().toISOString(),...entry})+'\n');}
  async applyManualOwnAction(manual,frame,{cancelPendingDecision=null,beforeFrame=null}={}){
    const session=this.session,adapter=this.adapter;
    if(cancelPendingDecision){
      cancelPendingDecision.callSearch?.cancel();
      adapter.call=null;
      this.pending=null;this.special=null;this.kongDraw=null;
      session.requests=[...cancelPendingDecision.input.requests];
      session.responses=[...cancelPendingDecision.input.responses,'PASS'];
      session.ledger=structuredClone(cancelPendingDecision.ledger);
      session.pending=null;
    }
    if(manual.commitRequests?.length){
      session.observeVerified({verified:true,requests:manual.commitRequests},manual.expectedCommitHand);
    }
    if(manual.acceptedRiichi&&adapter.points){
      try{adapter.acceptRiichi(manual.acceptedRiichi);}catch{}
    }
    this.opening=null;this.openingConsumed=[];this.snapshotEvent=null;this.kongDraw=null;this.consumed=[];
    this.ponWatch=null;
    this.manualAppliedFrame=frame.id??frame;
    const baseline=manual.calledAway&&beforeFrame
      ?{...frame,
        opponent_melds:structuredClone(beforeFrame.opponent_melds),
        rivers:{
          ...frame.rivers,
          self:{
            ...frame.rivers.self,
            tiles:[...(frame.rivers.self?.tiles??[]),{tile:manual.calledAway.tile,sideways:manual.action.startsWith('LIZHI '),color:{verified:true},tracking:false}],
          },
          [manual.calledAway.position]:structuredClone(beforeFrame.rivers[manual.calledAway.position]),
        }}
      :frame;
    this.publicFrame=baseline;
    if(!manual.needsDecision){
      this.anchor={decision:{output:{response:manual.action},visibleHand:[...manual.expectedCommitHand],ledger:structuredClone(session.ledger)},before:baseline};
    }
    await this.record({
      kind:'manual_own_action',frame:frame.id,action:manual.action,requests:manual.requests,
      preempted:cancelPendingDecision?.output?.response??null,
    });
    if(manual.acceptedRiichi)await this.updateAutoWin(frame).catch(()=>{});
    if(manual.needsDecision&&manual.decisionEvent){
      this.manualDecision={event:manual.decisionEvent,rinshanVerified:!!manual.rinshanVerified};
      return this.stepOnce(frame);
    }
    if(manual.calledAway)return this.stepOnce(frame);
    return {status:'manual_action_observed',action:manual.action,frame:frame.id};
  }
  waitForAutomaticNorth(frame,requests,{damaNorth=false,northWaits=false,manualKitaAt=null,tsumoClickedAt=null}={}){
    // Commit the draw only once the stock and replacement (or river) prove the extraction.
    const prefix=requests.map(r=>({...r,validact:null}));
    const ledger=prefix.reduce(applyPublicEvent,this.session.ledger);
    this.automaticNorth={
      before:frame,started:performance.now(),prefix,
      damaNorth,northWaits,manualKitaAt,tsumoClickedAt,
      damaFrames:new Set(frame?.id?[frame.id]:[]),
      decision:{
        visibleHand:frame.hand.tiles.map(t=>t.tile),ledger,output:{response:'KITA Z4'},input:{requests:[],responses:[]}
      },
    };
    return {status:damaNorth?'waiting_dama_north_button':'waiting_auto_kita_draw'};
  }
  acceptAutomaticReplacement(frame,proof){
    const nextTile=proof.request.state.split(' ')[1];
    const wasDamaNorth=this.automaticNorth?.damaNorth===true;
    if(!wasDamaNorth&&automaticNorthDraw(frame,this.adapter.autoKitaOutput,nextTile))return false;
    const requests=[...this.automaticNorth.prefix,{state:`3 ${this.session.seat} KITA Z4`,validact:null},...(proof.extra??[])];
    this.session.observeVerified({verified:true,requests},frame.hand.tiles.slice(0,-1).map(t=>t.tile));
    this.adapter.kitaEvidence?.observe(frame);
    this.opening=null;this.kongDraw=null;this.consumed=[];
    this.rinshanFrame=frame;
    this.publicFrame=frame;
    if(wasDamaNorth&&nextTile==='Z4'){
      const nextDama=isDamaTenpaiNorthDraw(frame,{
        riichi:this.riichiPassive===true,
        history:this.session.requests,
        draw:'Z4',
        kokushiRouteActive:this.adapter.kokushiRoute?.active===true,
      });
      this.waitForAutomaticNorth(frame,[{state:'2 Z4',validact:null}],{
        damaNorth:true,
        northWaits:!!nextDama?.northWaits,
      });
      return 'chain_dama_north';
    }
    this.automaticNorth=null;
    this.snapshotEvent=proof.request;
    return true;
  }
  passiveRiichi(frame){
    if(this.pending||this.special||this.adapter.call||this.session.pending)return false;
    if(declaredSeats(this.session.requests).has(this.session.seat)&&frame.auto_win?.verified&&frame.auto_win.enabled)this.riichiPassive=true;
    return this.riichiPassive===true&&!riichiDecisionPrompt(frame,this.session,this.adapter);
  }
  async updateAutoWin(frame){
    this.autoWin??=new AutoWin();
    const sent=await this.autoWin.update(frame,this.adapter);
    if(sent){this.autoInputStatus='auto_win_sent';await this.record({kind:'auto_win_enable_sent',frame:frame.id});}
    if(this.autoWin.confirmedNow)await this.record({kind:'auto_win_confirmed',frame:frame.id});
    if(sent||!GAME.sanma)return sent;
    this.autoKita??=new AutoKita();
    const riichiConfirmed=declaredSeats(this.session?.requests??[]).has(this.session?.seat);
    const kitaSent=await this.autoKita.update(frame,this.adapter,{riichiConfirmed});
    if(kitaSent){this.autoInputStatus='auto_kita_sent';await this.record({kind:'auto_kita_enable_sent',frame:frame.id});}
    if(this.autoKita.confirmedNow)await this.record({kind:'auto_kita_confirmed',frame:frame.id});
    return kitaSent;
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
    this.unresolvedSince??=performance.now();
    this.evidenceWaitReasons??=new Set();
    this.evidenceWaitRetries??=new Map();
    const retry=this.evidenceWaitRetries.get(reason)??{frames:0,blockedFrames:0,lastFrame:null};
    // Public-event inference can legitimately wait while an opponent is
    // calling/discarding. Repeated observations alone do not prove that an
    // action is blocked. Count only fresh frames requiring our own action.
    const c=frame.controls??{},h=frame.hand,m=frame.own_melds;
    const ownCount=m?.complete?14-3*m.groups.length:null;
    const ownDraw=h?.phase==='discard'||ownCount!==null&&
      (h?.tiles?.length===ownCount||h?.expected_count===ownCount);
    const decisionRequired=!!(frame.selection?.verified||frame.call_choices?.verified||
      ['PASS','CHI','PENG','GANG','ANGANG','BUGANG','KITA','LIZHI','TSUMO','RONG','HU','KYUSHU'].some(k=>c[k])||ownDraw);
    if(!decisionRequired)for(const wait of this.evidenceWaitRetries.values())wait.blockedFrames=0;
    if(retry.lastFrame!==frame.id){
      retry.frames++;retry.lastFrame=frame.id;
      retry.blockedFrames=decisionRequired?(retry.blockedFrames??0)+1:0;
    }
    this.evidenceWaitRetries.set(reason,retry);
    if(!this.evidenceWaitReasons.has(reason)){
      this.recoveringEvidence=true;
      if(retry.frames===1)await this.record({kind:'evidence_wait',frame:frame.id,reason});
      if(retry.blockedFrames>=2){
        this.evidenceWaitReasons.add(reason);
        await this.record({kind:'evidence_blocked',frame:frame.id,reason,retriedFrames:retry.frames,decisionRequired:true});
      }
    }
    // Keep the committed history and keep observing. A later complete frame
    // may bridge the gap; settlement/round handling still runs on every step.
    // Never confirm or resend pending mouse input as part of this recovery.
    return {status:'waiting_public_frame',reason};
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
      // A changing/misread wall numeral and disappearing buttons are also
      // normal during a successful call animation. Require an actual later
      // opponent discard, with its old river prefix intact.
      const source=Number((pending.decision.input?.requests?.at(-1)?.state??'').split(' ')[1]);
      const advanced=GAME.opponents.some(p=>{
        if(frame.round.seat_identity.seats[p]===source)return false;
        const a=pending.before.rivers?.[p],b=frame.rivers?.[p];
        return a?.complete&&b?.complete&&b.tiles.length>a.tiles.length&&
          a.tiles.every((t,i)=>t.tile===b.tiles[i]?.tile&&t.sideways===b.tiles[i]?.sideways)&&
          b.tiles.slice(a.tiles.length).every(t=>t.color?.verified&&!t.tracking&&typeof t.sideways==='boolean');
      });
      const claimed=overriddenCall(pending.decision,pending.before,frame);
      if(sameMelds&&(drawn||(waiting&&(claimed||(advanced&&!sameReactionWindow(pending.before,frame)))))){
        await session.dismissUnexecutedCall();
        this.adapter.call=null;this.special=null;this.consumed=[];
        this.publicFrame=pending.before;
        // Selection brightness was requested only for the obsolete call.
        delete frame.selection;
        await this.record({kind:'unexecuted_call_closed',decisionId:pending.decision.input?.call_search?.id,frame:frame.id,action,reason,claimed});
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
      const kita=observedOwnKitaDiscard(pending,frame);
      if(kita){
        const original=session.pending;
        session.pending=kita.decision;
        try{await session.confirm(kita.actual);}catch(error){session.pending=original;throw error;}
        this.pending=null;this.kongDraw=null;this.adapter.call=null;
        this.publicFrame=kita.baseline;this.consumed=[];this.opening=null;this.snapshotEvent=null;
        await this.record({kind:'observed_own_kita_discard',frame:frame.id,decisionId:original.input?.call_search?.id,
          requested:kita.requested,actual:kita.actual,draw:kita.draw,draws:kita.draws,orderKnown:kita.orderKnown,requests:kita.extra,source:'visible-kita-stock-hand-and-river'});
        return this.stepOnce(frame);
      }
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
      if(!observedPon(this.ponWatch,frame)&&!this.session.pending&&typeof this.session.reconcileVisibleHand==='function'&&
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
      // Retry the observation, never replace the history of a running hand.
      this.handConflictRetries=(this.handConflictRetries??0)+1;
      await this.record({kind:error.code==='COMMITTED_PREFIX_CONFLICT'?'committed_prefix_conflict':'hand_history_conflict',frame:this.frame?.id,reason:error.message,committed:error.committed,observed:error.observed,retry:this.handConflictRetries,recoveryOnFreshFrame:false});
      return {status:'retry_fresh_observation',reason:error.message};
    }
  }
  async stepOnce(readyFrame=null){
    let start=performance.now();const adapter=this.adapter,session=this.session;
    if(this.terminal)return {status:'hand_ended',...this.terminal};
    if(this.signal?.aborted)return {status:'stopped',pending:!!(this.pending||this.special)};
    if(this.special){
      this.special.meldObservations??=this.meldObservations;
      this.special.boundaryTracker??=this.boundaryTracker;
      const decisionId=this.special.decision.input?.call_search?.id;
      this.special.reportDiscardDecision=(action,metrics,frame,telemetry)=>this.record({kind:'post_call_discard_decision',decisionId,action,metrics,telemetry,waits:discardWaits(frame,waitHistory(session),action)});
      this.special.reportReplacement=(requested,actual)=>this.record({kind:'default_action_replacement',decisionId,requested,actual});
      const result=await advanceStaged(adapter,session,this.special);
      if(result.status==='waiting_round_frame')return result;
      if(result.status==='match_ended'){
        this.autoWinGuard?.reset();
        this.special.decision?.callSearch?.cancel();
        if(result.abnormal)await this.record({kind:'abnormal_match_end',frame:result.frame,reason:result.reason,elapsedMs:result.elapsedMs,pendingAction:result.pendingAction??null});
        return result;
      }
      if(result.status==='round_boundary'){
        this.autoWinGuard?.reset();
        this.special.decision?.callSearch?.cancel();
        await this.record({kind:'round_boundary',frame:result.frame,before:result.before,after:result.after,abnormal:!!result.abnormal,sameRoundReset:!!result.sameRoundReset,reason:result.reason??null,pendingAction:result.pendingAction??null});
        return result;
      }
      if(result.status==='kita_already_discarded'){
        const {played,frame}=result;
        this.special=null;this.kongDraw=null;this.publicFrame=played.baseline;this.consumed=[];
        await this.record({kind:'kita_discard_observed',draw:played.draw,draws:played.draws,orderKnown:played.orderKnown,action:played.actual,frame:frame.id});
        return this.stepOnce(frame);
      }
      if(result.status==='auto_kita_updated'){
        if(result.toggle.sent)await this.record({kind:'auto_kita_enable_sent',frame:result.frame});
        if(result.toggle.confirmedNow)await this.record({kind:'auto_kita_confirmed',frame:result.frame});
        return result;
      }
      this.meldObservations=this.special.meldObservations;
      const ron=callOverriddenByRon(this.special,this.special.latest??{});
      if(ron){
        const current=this.special.latest,action=this.special.decision.output.response;
        await session.dismissUnexecutedCall();this.adapter.call=null;this.special=null;
        await this.record({kind:'unexecuted_call_closed',decisionId,frame:current.id,action,claimed:ron});
        return this.stepOnce(current);
      }
      if(result.status==='waiting_special_settlement')return result;
      if(result.status==='call_combination_corrected'){await this.record({kind:'call_combination_corrected',decisionId,...result});return result;}
      // Staged confirmation must not mute independently visible public events.
      if(this.special.latest){
        const fresh=this.visibleLog.observe(this.special.latest,{includeSelf:!!this.special.decision.riichiKongPrompt});
        if(fresh.length)await this.record({kind:'visible_public_events',frame:this.special.latest.id,requests:fresh,source:'staged-visible-position-diff'});
      }
      // Let the staged retry handle the surviving prompt with the original decision.
      if(result.status==='waiting_kong_effect'&&this.special.decision.output.response==='KITA Z4'&&
         sameKitaOffer(this.special.before,this.special.latest))return result;
      if(result.status.startsWith('waiting_')&&this.special.latest&&!this.special.callObserved&&
         this.special.latest.hand?.complete&&!this.special.latest.hand.rejected?.length&&
         this.special.latest.own_melds?.complete&&!this.special.latest.selection?.verified&&!this.special.latest.call_choices?.verified){
        const manual=detectManualOwnAction(
          this.special.before,this.special.latest,
          {seat:session.seat,ledger:this.special.decision.ledger,requests:this.special.decision.input.requests},
          {allowPendingBase:true,inSpecial:true},
        );
        const sameKitaChain=this.special.decision.output.response==='KITA Z4'&&manual?.action?.startsWith('KITA Z4');
        if(manual?.verified&&manual.action!==this.special.decision.output.response&&!sameKitaChain){
          return this.applyManualOwnAction(manual,this.special.latest,{cancelPendingDecision:this.special.decision,beforeFrame:this.special.before});
        }
      }
      const autoKitaChaining=result.status==='waiting_kong_effect'&&this.special.decision.output.response==='KITA Z4'&&/自动拔北|连续拔北/.test(result.reason??'');
      if(result.status.startsWith('waiting_')&&!this.special.callObserved&&performance.now()-this.special.started>(autoKitaChaining?5000:1200)){
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
          if(await this.updateAutoWin(current))return {status:this.autoInputStatus??'auto_win_sent',frame:current.id};
          return {status:'waiting_discard_river',frame:current.id};
        }
        const oldRemaining=this.special.before.round?.remaining?.value,newRemaining=current.round?.remaining?.value;
        const progressed=Number.isInteger(oldRemaining)&&Number.isInteger(newRemaining)&&newRemaining<oldRemaining;
        const reaction=current.controls?.HU||current.controls?.RONG||current.controls?.TSUMO||current.controls?.PASS;
        if((progressed||reaction)&&
           current.hand?.complete&&current.own_melds?.complete&&!changedRound(this.special.before,current)){
          if(!current.call_choices?.verified&&!current.selection?.verified){
            this.special.firstUnconfirmedAt??=this.special.started;
            const action=this.special.decision.output.response;
            return this.recoverTransaction(current,`等待确认 ${action}：${result.reason??'尚未读到执行结果'}`,this.special);
          }
        }
      }
      if(result.status==='locked_kong_confirmed'){
        this.publicFrame=result.frame;this.consumed=[];this.special=null;this.kongDraw=null;
        await this.record({kind:'kong_confirmation',action:result.decision.output.response,before:result.before.id,after:result.frame.id});
        return {status:'riichi_auto_play',frame:result.frame.id};
      }
      if(result.status==='kong_confirmed'){
        if(result.chain){
          this.rinshanFrame=result.frame;
          this.snapshotEvent=result.request;this.publicFrame=result.frame;this.special=null;this.kongDraw=null;this.consumed=[];
          await this.record({kind:'kong_confirmation',action:result.decision.output.response,before:result.before.id,after:result.frame.id,draw:result.request,chain:true,draws:result.draws});
          return this.stepOnce(result.frame);
        }
        this.kongDraw=result;this.rinshanFrame=result.frame;this.consumed=[];this.publicFrame=null;this.special=null;
        await this.record({kind:'kong_confirmation',action:result.decision.output.response,before:result.before.id,after:result.frame.id,draw:result.request});
        return {status:'kong_draw_ready'};
      }
      if(result.status==='special_confirmed'){
        this.anchor=result.anchor;this.consumed=[];this.publicFrame=null;
        await this.record({kind:'confirmation',action:this.special.decision.output.response,before:this.special.before.id,after:result.frame,confirmationMs:result.totalMs,riverTracking:result.riverTracking});
        const current=this.special.latest;this.special=null;
        if(result.nextDraw){delete current.selection;return this.stepOnce(current);}
      }else if(['special_discard_sent','special_choice_sent'].includes(result.status))await this.record({kind:'staged_input',telemetry:this.special.decision.telemetry,action:this.special.decision.output.response,...result,withinBudget:result.totalMs<=5000});
      else if(result.status==='special_discard_retried')await this.record({kind:'verified_unchanged_discard_retry',decisionId,...result,withinBudget:result.totalMs<=5000});
      else if(result.status==='special_discard_prompt_dismissed')await this.record({kind:'discard_prompt_dismissed',decisionId,...result});
      else if(result.status==='special_button_retried')await this.record({kind:'verified_unchanged_riichi_retry',action:this.special.decision.output.response,...result,withinBudget:false});
      else if(result.status==='unresolved_special_effect')await this.record({kind:'unresolved',...result});
      return result;
    }
    // After a kong draw is submitted, kongDraw is cleared but its discard is
    // still pending. Keep that post-kong layout until confirmation updates the
    // anchor; reverting to the pre-kong anchor makes every later hand incomplete.
    const inspectOptions={meld_count:this.pending?.before.hand.meld_count??this.kongDraw?.frame.hand.meld_count??this.publicFrame?.hand.meld_count??this.anchor.before.hand.meld_count,auto_meld_count:true,phase:'auto',observeSettlement:true,fast_rivers:typeof adapter.refineRivers==='function'};
    const kitaDraw=!this.automaticNorth&&this.kongDraw?.decision?.output?.response==='KITA Z4'?this.kongDraw:null;
    if(!readyFrame&&kitaDraw&&!kitaDraw.usedConfirmationFrame&&adapter.latest===kitaDraw.frame&&!kitaDraw.frame.hand?.tiles.some(t=>t.tile==='Z4')){
      kitaDraw.usedConfirmationFrame=true;
      readyFrame=kitaDraw.frame;
    }
    let raw=readyFrame??await adapter.inspect(inspectOptions);
    this.rawFrame=raw;
    if(raw.terminal_phase?.name==='match_end'){this.autoWinGuard?.reset();session.pending?.callSearch?.cancel();return {status:'match_ended',frame:raw.id,pendingAction:session.pending?.output?.response??null};}
    if(this.recoveredKong)raw=recoverOwnKong(this.recoveredKong,raw);
    if(raw.settlement?.complete){
      this.autoWinGuard?.reset();
      this.boundaryTracker.markSettlement();
      const signature=JSON.stringify(Object.fromEntries(Object.entries(raw.settlement.scores).map(([p,s])=>[p,s.value])));
      if(this.lastSettlementSignature!==signature){
        await this.record({kind:'settlement_observation',frame:raw.id,scores:raw.settlement.scores,confirmed:false});
        this.lastSettlementSignature=signature;
      }
      if(this.anchor.before?.round?.seat_identity?.seats){
        try{
          this.passiveScores??=new SettlementCollector();
          this.passiveScores.observe(raw,this.anchor.before.round.seat_identity.seats);
          this.passiveCandidate=this.passiveScores.candidate;
        }catch{this.passiveCandidate=null;}
        this.passiveSettlementFrame=raw;
      }
      return {status:'observing_settlement',frame:raw.id};
    }
    if(raw.result_page?.kind==='own-win-settlement'){
      this.autoWinGuard?.reset();
      this.boundaryTracker.markSettlement();
      return {status:'observing_settlement',frame:raw.id};
    }
    const boundary=changedRound(this.anchor.before,raw);
    if(boundary){
      this.autoWinGuard?.reset();
      session.pending?.callSearch?.cancel();
      if(this.passiveCandidate&&!this.pending&&!session.pending){
        await this.record({kind:'settlement_candidate',candidate:this.passiveCandidate,nextFrame:raw.id});
        return {status:'hand_ended',proof:this.passiveCandidate};
      }
      await this.record({kind:'round_boundary',frame:raw.id,...boundary,pendingAction:this.pending?.decision.output.response??null});
      return {status:'round_boundary',frame:raw.id,...boundary,proof:this.passiveCandidate??null};
    }
    const abnormalExit=this.boundaryTracker.observe(this.anchor.before,raw,{resetBaseline:this.pending?.before??this.publicFrame??this.anchor.before});
    if(abnormalExit){
      if(abnormalExit.status==='waiting_round_frame')return abnormalExit;
      this.autoWinGuard?.reset();
      session.pending?.callSearch?.cancel();
      if(abnormalExit.status==='match_ended'){
        await this.record({kind:'abnormal_match_end',frame:abnormalExit.frame,reason:abnormalExit.reason,elapsedMs:abnormalExit.elapsedMs,pendingAction:session.pending?.output?.response??null});
        return {...abnormalExit,pendingAction:session.pending?.output?.response??null};
      }
      if(abnormalExit.status==='round_boundary'){
        await this.record({kind:'round_boundary',frame:abnormalExit.frame,before:abnormalExit.before,after:abnormalExit.after,abnormal:true,sameRoundReset:!!abnormalExit.sameRoundReset,reason:abnormalExit.reason,pendingAction:this.pending?.decision.output.response??null});
        return {...abnormalExit,pendingAction:this.pending?.decision.output.response??null,proof:this.passiveCandidate??null};
      }
    }
    // Result overlays hide the wind/hand/counters. They are not a playable
    // table and must not enter meld/event inference or its failure timeout.
    if(!roundIdentity(raw))return {status:'waiting_round_frame',frame:raw.id};
    this.passiveSettlementFrame=null;this.passiveCandidate=null;
    if(!this.riverObservations){this.riverObservations=new RiverObservationCache();this.riverObservations.apply(this.anchor.before);}
    if(!this.pending&&!this.special&&!this.adapter.call){
      const conflicts=this.riverObservations.conflicts(raw);
      this.discardCorrections??=new Map();
      const fix=reviseObservedTail(this.observedTail,session,raw)??(conflicts.length?reviseOlderDiscard(this.discardCorrections,session,raw,conflicts):(this.discardCorrections.clear(),null));
      if(fix){
        // Advance only this slot in our baseline. Keep all other evidence and history.
        const patch=f=>{const t=f?.rivers?.[fix.pos]?.tiles?.[fix.slot];if(!t||t.tile!==fix.was.split(' ').at(-1))return f;const out=structuredClone(f);out.rivers[fix.pos].tiles[fix.slot]=structuredClone(fix.tile);return out;};
        this.publicFrame=patch(this.publicFrame);
        this.anchor.before=patch(this.anchor.before);
        const source=this.riverObservations.sources.get(fix.pos);
        if(source)this.riverObservations.sources.set(fix.pos,patch(source));
        if(this.openingConsumed?.length&&!fix.historical)this.openingConsumed[this.openingConsumed.length-1]=fix.state;
        this.reactionEvidence=null;this.lastReactionKey=null;this.observedTail=null;
        this.visibleLog.players[fix.pos]?.slots.set(fix.slot,structuredClone(fix.tile));
        if(this.visibleLog.callSources.get(fix.pos)?.slot===fix.slot)this.visibleLog.callSources.delete(fix.pos);
        const seat=raw.round.seat_identity.seats[fix.pos];
        this.adapter.callWaitEvidence?.forgetCorrectedDiscard(seat,fix.slot);
        const q=raw.opponent_hand_constraints;
        if(q?.constraints)raw.opponent_hand_constraints={...q,constraints:q.constraints.filter(c=>c.discard?.seat!==seat||c.discard.river_index!==fix.slot)};
        await this.record({kind:'observed_discard_corrected',frame:raw.id,previous:fix.was,state:fix.state,index:fix.index,slot:fix.slot,historical:!!fix.historical});
      }
    }
    const conflicts=this.riverObservations.conflicts(raw);
    if(conflicts.length){
      // Old immutable identities are retained by the cache below. An old
      // face disagreement must not put another capture on the decision path.
      await this.record({kind:'recognition_conflict_retained',frame:raw.id,conflicts});
    }
    this.autoWinGuard?.syncRound(raw);
    if(this.autoWinGuard?.isIdleFor(raw))return {status:'idle_until_next_round',frame:raw.id};
    const kitaWallBefore=kitaDraw?(kitaDraw.frame.round?.remaining?.estimated?kitaDraw.frame.round.remaining.observedValue:kitaDraw.frame.round?.remaining?.value):null;
    const kitaWallNow=raw.round?.remaining?.estimated?raw.round.remaining.observedValue:raw.round?.remaining?.value;
    const kitaHandSame=kitaDraw&&raw.hand?.complete&&kitaDraw.frame.hand?.complete&&
      JSON.stringify(raw.hand.tiles.map(t=>t.tile))===JSON.stringify(kitaDraw.frame.hand.tiles.map(t=>t.tile));
    const kitaExcessUnverified=kitaDraw&&Number.isInteger(kitaDraw.frame.kita?.self?.count)&&
      raw.kita?.self?.count>kitaDraw.frame.kita.self.count&&!confirmedNorthStock(raw.kita?.self)&&
      kitaHandSame&&(kitaWallBefore===kitaWallNow||kitaWallNow==null);
    const kitaWallFurtherDropped=kitaDraw&&Number.isInteger(kitaWallBefore)&&Number.isInteger(kitaWallNow)&&kitaWallNow<kitaWallBefore;
    if(kitaDraw&&raw.id!==kitaDraw.frame.id&&!kitaExcessUnverified&&
       ((Number.isInteger(kitaDraw.frame.kita?.self?.count)&&raw.kita?.self?.count>kitaDraw.frame.kita.self.count)||kitaWallFurtherDropped)){
      const {before,decision}=kitaDraw;
      const played=observedOwnKitaDiscard({before,decision,knownKitaDraws:[kitaDraw.request.state.split(' ')[1]]},raw);
      if(played){
        session.observeVerified({verified:true,requests:[...played.extra.slice(1),{state:'3 '+session.seat+' '+played.actual,validact:null}]},played.baseline.hand.tiles.map(t=>t.tile));
        this.kongDraw=null;this.rinshanFrame=null;this.publicFrame=played.baseline;this.consumed=[];
        await this.record({kind:'kita_discard_observed',draw:played.draw,draws:played.draws,orderKnown:played.orderKnown,action:played.actual,frame:raw.id});
        return this.stepOnce(raw);
      }
      if(!decision.singleNorth&&automaticNorthDraw(raw,adapter.autoKitaOutput,raw.hand?.tiles?.at(-1)?.tile))
        return this.waitForEvidence(raw,'已继续拔北，等待自动拔北完成');
      kitaDraw.chainLagSince??=performance.now();
      kitaDraw.chainLagFrames=(kitaDraw.chainLagFrames??0)+1;
      const allowWallLag=performance.now()-kitaDraw.chainLagSince>=350||kitaDraw.chainLagFrames>=2;
      const kitaFrame=this.riverObservations?this.riverObservations.apply(raw):raw;
      const chain=verifiedNorthChain(before,kitaFrame,decision.visibleHand,session.seat,{allowWallLag});
      if(!chain)return this.waitForEvidence(raw,'已继续拔北，等待补摸手牌读全');
      session.observeVerified({verified:true,requests:chain.extra},raw.hand.tiles.slice(0,-1).map(t=>t.tile));
      adapter.kitaEvidence?.observe(raw);
      this.rinshanFrame=raw;
      this.snapshotEvent=chain.request;this.kongDraw=null;this.publicFrame=raw;this.consumed=[];
      return this.stepOnce(raw);
    }
    const riichiAutoPlay=this.passiveRiichi(raw);
    if(!riichiAutoPlay||!GAME.sanma||adapter.kokushiRoute?.active)this.passiveKitaOffer=null;
    if(await adapter.kokushiRoute?.disableAutoNorth(raw,adapter))return {status:'waiting_auto_kita_off',frame:raw.id};
    if(!riichiAutoPlay)await this.onDecisionButtons?.();
    raw.rinshan_verified=sameRinshanDraw(raw,this.kongDraw?.frame??this.rinshanFrame);
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
    const recentObservation=this.lastDecisionObservation;
    this.lastDecisionObservation=structuredClone(frame);
    this.reactionObservations??=new ReactionObservationCache();
    const reactionEvidence=this.reactionObservations.observe(frame)??newDiscardEvidence(recentObservation,frame);
    const visiblePrompt=promptDiscard(frame);
    if(reactionEvidence&&(!frame.controls?.CHI||reactionEvidence.position==='left'))this.reactionEvidence=reactionEvidence;
    else if(visiblePrompt)this.reactionEvidence=visiblePrompt;
    else if((recentObservation?.controls?.PASS&&!frame.controls?.PASS)||
      frame.hand?.tiles?.length===14-3*(frame.own_melds?.groups?.length??0)||
      JSON.stringify(this.reactionEvidence?.round)!==JSON.stringify(roundIdentity(frame)))this.reactionEvidence=null;
    this.independentDisplay=true;
    const visibleRequests=this.visibleLog.observe(frame,{includeSelf:riichiAutoPlay||this.riichiPassive===true});
    if(!riichiAutoPlay&&!this.riichiPassive&&frame.controls?.PASS){
      const notice=visiblePrompt??reactionEvidence;
      if(notice&&matchesCallButtons(frame,notice.event)){
        const slot=this.visibleLog.players[notice.position]?.slots.get(notice.slot);
        const event=slot?.markerOnly&&slot.tile===notice.tile?{...notice.event,state:notice.event.state.replace(' LIZHI ',' PLAY ')}:notice.event;
        this.bindButtons?.({...notice,event});
      }
    }
    if(visibleRequests.length)await this.record({kind:'visible_public_events',frame:frame.id,requests:visibleRequests,source:'visible-position-diff'});
    if(riichiAutoPlay){
      this.kongDraw=null;this.publicFrame=structuredClone(frame);
      const guard=await this.autoWinGuard.evaluate(frame,{session,adapter,riichi:true,record:e=>this.record(e)});
      if(guard.action==='wait')return {status:guard.status,winKind:guard.winKind,frame:frame.id};
      if(guard.action==='auto_win_toggle')return {status:guard.status,frame:frame.id};
      if(guard.action==='idle')return {status:guard.status,frame:frame.id};
      if(guard.action==='recovered'&&guard.rescanned)return this.stepOnce(guard.rescanned);
      // Passive riichi still has client toggles to confirm/enable/retry.
      // Publish this frame's events first, then service them before yielding.
      if(await this.updateAutoWin(frame))return {status:this.autoInputStatus??'auto_win_sent',frame:frame.id};
      if(GAME.sanma&&!adapter.kokushiRoute?.active){
        const northCount=raw.hand?.complete&&!raw.hand.rejected?.length?raw.hand.tiles.filter(t=>t.tile==='Z4').length:null;
        const key=JSON.stringify([roundIdentity(raw),raw.kita?.self?.count,northCount]);
        if(raw.controls?.KITA?.center){
          if(!this.passiveKitaOffer||(northCount!==null&&this.passiveKitaOffer.key!==key)){
            this.passiveKitaOffer={key,before:raw,started:performance.now()};
          }else{
            const center=stalledKitaButton(this.passiveKitaOffer,raw);
            if(center){
              await adapter.sendClick(raw,center,'ui');
              await this.record({kind:'auto_kita_fallback_click',action:'KITA Z4',frame:raw.id});
            }
          }
        }else if(this.passiveKitaOffer&&northCount!==null&&this.passiveKitaOffer.key!==key){
          this.passiveKitaOffer=null;
        }
      }
      return {status:'riichi_auto_play',frame:frame.id};
    }
    if(await this.onVisibleFrame?.(frame)===true)return {status:'retry_fresh_observation',reason:'可选界面操作已消耗本帧，重新获取画面'};
    if(this.outputRecovery){
      const result=await this.recoverTransaction(frame,this.outputRecovery.reason,this.outputRecovery);
      if(result.status==='recovered_current_turn')this.outputRecovery=null;
      return result;
    }
    if(this.ponWatch&&!this.pending&&session.requests?.at(-1)?.state!==this.ponWatch.decision.input.requests.at(-1)?.state)this.ponWatch=null;
    const recoveredPon=observedPon(this.ponWatch,frame);
    if(recoveredPon&&this.pending?.decision===this.ponWatch.decision){
      const p=this.pending.decision;
      session.requests=[...p.input.requests];session.responses=[...p.input.responses,'PASS'];
      session.ledger=structuredClone(p.ledger);session.pending=null;this.pending=null;
      this.publicFrame=this.ponWatch.before;this.opening=null;this.snapshotEvent=null;this.consumed=[];
    }
    if(this.pending){
      const p=this.pending;
      // Detect preemptive manual own action during pending PASS/PLAY before stale verification/retry.
      if((frame.id??frame)!==this.manualAppliedFrame&&session.pending===p.decision&&frame.hand?.complete&&!frame.hand.rejected?.length&&frame.own_melds?.complete&&
         !frame.selection?.verified&&!frame.call_choices?.verified){
        const manual=detectManualOwnAction(
          p.before,frame,
          {seat:session.seat,ledger:p.decision.ledger,requests:p.decision.input.requests},
          {allowPendingBase:true},
        );
        if(manual?.verified&&manual.action!==p.decision.output.response){
          return this.applyManualOwnAction(manual,frame,{cancelPendingDecision:p.decision,beforeFrame:p.before});
        }
      }
      // Handle a visibly ineffective ordinary click before any history/call
      // reconstruction. Unrelated river/meld OCR cannot veto local proof.
      const inputFrame=p.inputFrame??p.before;
      if(GAME.sanma&&p.decision.output.response.startsWith('PLAY ')&&session.pending===p.decision&&
         Number.isInteger(inputFrame.kita?.self?.count)&&raw.kita?.self?.count>inputFrame.kita.self.count&&
         raw.kita.self.tiles?.filter(t=>t.tile==='Z4'&&!t.tracking&&t.color?.verified).length===raw.kita.self.count){
        const actual={...p.decision,output:{...p.decision.output,response:'KITA Z4'}};
        const multiple=raw.kita.self.count-inputFrame.kita.self.count>1;
        let proof;
        if(multiple)proof=verifiedNorthChain(inputFrame,raw,actual.visibleHand,session.seat);
        else try{proof=verifyKongDraw(actual,inputFrame,raw);}catch{}
        if(proof){
          session.pending=actual;
          try{await session.confirm('KITA Z4');}catch(error){session.pending=p.decision;throw error;}
          this.pending=null;this.special=null;adapter.call=null;this.publicFrame=null;this.opening=null;this.snapshotEvent=null;this.consumed=[];
          if(multiple){
            session.observeVerified({verified:true,requests:proof.extra},raw.hand.tiles.slice(0,-1).map(t=>t.tile));
            this.kongDraw=null;this.snapshotEvent=proof.request;this.publicFrame=raw;
          }else this.kongDraw={...proof,decision:actual,before:inputFrame};
          await this.record({kind:'default_action_replacement',requested:p.decision.output.response,actual:'KITA Z4',frame:raw.id});
          return this.stepOnce(raw);
        }
      }
      const stableFrame=p.lastRetryObservation;
      p.lastRetryObservation=structuredClone(raw);
      const retryProven=unchangedDiscard(p.decision,inputFrame,raw,{stableFrame});
      if(retryProven){
        const fresh=raw.id!==p.lastRetryFrame&&(!p.lastRetryAt||!Number.isFinite(raw.captureStartedMono)||raw.captureStartedMono>=p.lastRetryAt);
        if(fresh&&(!p.lastRetryAt||performance.now()-p.lastRetryAt>=800)){
          if(this.signal?.aborted)return {status:'stopped',pending:!!(this.pending||this.special)};
          const retryStarted=performance.now();
          const receipt=await adapter.execute({...p.decision,observationId:raw.id,retryInput:true},raw);
          p.lastRetryAt=performance.now();p.lastRetryFrame=raw.id;p.firstUnconfirmedAt=p.lastRetryAt;
          p.discardRetryCount=(p.discardRetryCount??0)+1;
          await this.record({kind:'verified_unchanged_discard_retry',decisionId:p.decision.input?.call_search?.id,action:p.decision.output.response,before:inputFrame.id,after:raw.id,receipt,retryCount:p.discardRetryCount,operationMs:performance.now()-retryStarted,totalMs:performance.now()-p.started,withinBudget:performance.now()-p.started<=5000});
          return {status:'discard_retry_sent'};
        }
        return {status:'waiting_discard_effect'};
      }
      if(p.decision.output.response==='PASS'){
        const windowState=classifyPassWindow(inputFrame,raw,p.decision);
        if(windowState==='draw-menu'||windowState==='draw')p.passSuperseded=true;
        const reactionStillVisible=Object.keys(raw.controls??{}).some(k=>k==='PASS'||p.before.controls?.[k]);
        if(reactionStillVisible){
          // A later player's discard can open another reaction window before
          // our next capture. Prove public progression, not button absence.
          // A directly observed new discard proves that the previous PASS
          // window has ended, independently of unrelated missing history.
          const freshReaction=newDiscardEvidence(inputFrame,raw)??newDiscardEvidence(p.before,frame);
          const originalPrompt=promptDiscard(inputFrame);
          const changedPrompt=originalPrompt&&visiblePrompt&&(originalPrompt.position!==visiblePrompt.position||
            originalPrompt.slot!==visiblePrompt.slot||originalPrompt.tile!==visiblePrompt.tile);
          let progressed=!!(p.passSuperseded||freshReaction||changedPrompt);
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
            // The recognizer can lose PASS for a frame while PENG is still on
            // screen. Keep this decision, but never click a missing target.
            if(windowState!=='same')return {status:'waiting_pass_effect'};
            p.firstUnconfirmedAt??=performance.now();
            const attemptAt=p.lastRetryAt??p.sentAt??p.started;
            const attemptFrame=p.lastRetryFrame??inputFrame.id;
            if(performance.now()-attemptAt<800||raw.id===attemptFrame||
               (Number.isFinite(raw.captureStartedMono)&&raw.captureStartedMono<attemptAt))return {status:'waiting_pass_effect'};
            if(this.signal?.aborted)return {status:'stopped',pending:!!(this.pending||this.special)};
            const receipt=await adapter.pass({...p.decision,observationId:raw.id},raw,{retryVisibleButton:true});
            p.lastRetryAt=performance.now();p.lastRetryFrame=raw.id;
            p.effectRetryCount=(p.effectRetryCount??0)+1;
            await this.record({kind:'verified_unchanged_pass_retry',before:p.before.id,after:raw.id,receipt,retryCount:p.effectRetryCount});
            return {status:'pass_retry_sent'};
          }
        }
        if(!frame.hand?.complete)return {status:'waiting_pass_frame'};
        let visible=frame.hand.tiles.map(t=>t.tile);
        const onlyPass=raw.controls?.PASS&&Object.keys(raw.controls).length===1;
        if((windowState==='draw-menu'||p.passSuperseded&&onlyPass)&&visible.length===p.decision.visibleHand.length)
          return {status:'waiting_pass_frame'};
        // A skipped reaction can already be followed by our next draw. The
        // whole ordinary prefix must prove that draw before removing it here.
        if(windowState==='draw')visible.pop();
        else if(visible.length===p.decision.visibleHand.length+1){
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
        // A sideways declaration can discard exactly the tile requested by PLAY.
        // Confirming the hand removal first would lose that declaration.
        const newDeclaration=p.decision.output.response.startsWith('PLAY ')&&
          frame.rivers?.self?.tiles?.at(-1)?.sideways===true&&
          !p.before.rivers?.self?.tiles?.some(t=>t.sideways)&&
          !declaredSeats(session.requests).has(session.seat);
        let replacement=newDeclaration?replacedDiscard(p.decision,p.before,frame):null;
        try{
          try{if(!replacement)verifyDiscard(p.decision,p.before,frame);}
          catch(discardError){
            try{try{verifyLocalDiscard(p.decision,p.before,frame);}catch{try{verifyCalledDiscard(p.decision,p.before,frame);}catch{chainedCallSpan(p.decision,p.before,frame);}}}
            catch(callError){throw Error(`${discardError.message}; call alternative: ${callError.message}`);}
          }
        }
        catch(error){
          replacement=replacedDiscard(p.decision,p.before,frame);
          if(!replacement){
          if(discardLeftHand(p.decision,p.before,raw)){
            if(raw.hand?.complete&&raw.own_melds?.complete&&raw.hand.tiles.length===14-3*raw.own_melds.groups.length)
              return this.recoverTransaction(frame,error.message,p);
            if(await this.updateAutoWin(raw))return {status:this.autoInputStatus??'auto_win_sent',frame:raw.id};
            return {status:'waiting_discard_river',frame:raw.id};
          }
          p.firstUnconfirmedAt??=performance.now();
          const retryReady=performance.now()-(p.lastRetryAt??p.sentAt??p.started)>=800&&
            raw.id!==p.lastRetryFrame&&(!p.lastRetryAt||!Number.isFinite(raw.captureStartedMono)||raw.captureStartedMono>=p.lastRetryAt);
          if(retryReady&&unchangedDiscard(p.decision,p.before,raw,{stableFrame})){
            if(this.signal?.aborted)return {status:'stopped',pending:!!(this.pending||this.special)};
            const retryStarted=performance.now();
            const receipt=await adapter.execute({...p.decision,observationId:raw.id,retryInput:true},raw);
            p.lastRetryAt=performance.now();p.lastRetryFrame=raw.id;p.firstUnconfirmedAt=p.lastRetryAt;
            p.discardRetryCount=(p.discardRetryCount??0)+1;
            const totalMs=performance.now()-p.started;
            await this.record({kind:'verified_unchanged_discard_retry',decisionId:p.decision.input?.call_search?.id,action:p.decision.output.response,before:p.before.id,after:raw.id,receipt,retryCount:p.discardRetryCount,operationMs:performance.now()-retryStarted,totalMs,withinBudget:totalMs<=5000});
            return {status:'discard_retry_sent'};
          }
          if(unchangedDiscard(p.decision,p.before,raw,{stableFrame}))return {status:'waiting_discard_effect'};
          return this.recoverTransaction(frame,error.message,p);
          }
        }
        if(replacement){
          p.decision=replacement.decision;
          session.pending={...session.pending,output:{...session.pending.output,response:replacement.actual}};
          await this.record({kind:'default_action_replacement',decisionId:p.decision.input?.call_search?.id,frame:frame.id,requested:replacement.requested,actual:replacement.actual});
        }
      }
      await session.confirm(p.decision.output.response);
      await this.record({kind:'confirmation',action:p.decision.output.response,before:p.before.id,after:frame.id,confirmationMs:performance.now()-p.started});
      if(p.decision.output.response!=='PASS'){this.anchor={decision:p.decision,before:repairAnchorEvidence(p.before,frame)};this.consumed=[];this.publicFrame=null;}
      else if(p.publicMode)this.publicFrame=p.before;
      this.pending=null;
    }
    if(this.passiveRiichi(frame))return {status:'riichi_auto_play',frame:frame.id};
    // Animated hands can cover an otherwise unchanged meld band. Missing
    // visual evidence is not a contradictory event history: wait for a fresh
    // complete frame within the run's existing bound, without issuing input.
    if(!frame.hand?.complete||frame.hand.rejected?.length||(!frame.own_melds?.complete&&!recoveredPon))
      return this.waitForEvidence(frame,'手牌、副露或牌河暂未识别完整');
    if(this.automaticNorth){
      const p=this.automaticNorth;
      const played=observedOwnKitaDiscard(p,frame);
      if(played){
        session.observeVerified({verified:true,requests:[...p.prefix,...played.extra,{state:`3 ${session.seat} ${played.actual}`,validact:null}]},played.baseline.hand.tiles.map(t=>t.tile));
        this.automaticNorth=null;this.kongDraw=null;this.opening=null;this.snapshotEvent=null;this.consumed=[];this.publicFrame=played.baseline;
        await this.record({kind:'kita_discard_observed',frame:frame.id,draw:played.draw,draws:played.draws,orderKnown:played.orderKnown,action:played.actual});
        return {status:'observing'};
      }
      let proof;
      const oldNorth=p.before.kita?.self?.count,nowNorth=frame.kita?.self?.count;
      const oldW=p.before.round?.remaining?.estimated?p.before.round.remaining.observedValue:p.before.round?.remaining?.value;
      const nowW=frame.round?.remaining?.estimated?frame.round.remaining.observedValue:frame.round?.remaining?.value;
      const wallDrop=Number.isInteger(oldW)&&Number.isInteger(nowW)?oldW-nowW:null;
      const multiAuto=(Number.isInteger(oldNorth)&&Number.isInteger(nowNorth)&&nowNorth-oldNorth>1&&confirmedNorthStock(frame.kita?.self))||(wallDrop!==null&&wallDrop>1&&wallDrop<=4);
      if(multiAuto){
        p.chainLagSince??=performance.now();
        p.chainLagFrames=(p.chainLagFrames??0)+1;
        const allowWallLag=performance.now()-p.chainLagSince>=350||p.chainLagFrames>=2;
        proof=verifiedNorthChain(p.before,frame,p.decision.visibleHand,session.seat,{allowWallLag});
      }else{
        try{proof=verifyKongDraw(p.decision,p.before,frame,{localOnly:true});}catch{}
      }
      if(proof){
        const accepted=this.acceptAutomaticReplacement(frame,proof);
        if(!accepted)return this.waitForEvidence(frame,'等待自动拔北后的补摸');
        if(accepted==='chain_dama_north'){
          const nextAct=damaNorthAction(this.automaticNorth,raw);
          if(nextAct?.kind==='tsumo'){
            await adapter.sendClick(raw,nextAct.center,'ui');
            await this.record({kind:'dama_north_tsumo_click',frame:raw.id});
            return {status:'waiting_win_settlement',frame:raw.id};
          }
          if(nextAct?.kind==='kita'){
            await adapter.sendClick(raw,nextAct.center,'ui');
            await this.record({kind:'dama_north_kita_click',frame:raw.id});
            return {status:'dama_north_kita_sent',frame:raw.id};
          }
          return this.waitForEvidence(frame,'默听补摸仍为北风，等待自摸或拔北按钮');
        }
        const rinshanTsumo=tsumoButtonCenter(raw);
        if(rinshanTsumo){
          await adapter.sendClick(raw,rinshanTsumo,'ui');
          await this.record({kind:'dama_north_tsumo_click',frame:raw.id});
          this.snapshotEvent=null;
          return {status:'waiting_win_settlement',frame:raw.id};
        }
      }else if(p.damaNorth){
        const act=damaNorthAction(p,raw);
        if(act?.kind==='tsumo'){
          await adapter.sendClick(raw,act.center,'ui');
          await this.record({kind:'dama_north_tsumo_click',frame:raw.id});
          return {status:'waiting_win_settlement',frame:raw.id};
        }
        if(act?.kind==='wait_tsumo')return {status:'waiting_win_settlement',frame:raw.id};
        if(act?.kind==='kita'){
          await adapter.sendClick(raw,act.center,'ui');
          await this.record({kind:'dama_north_kita_click',frame:raw.id});
          return {status:'dama_north_kita_sent',frame:raw.id};
        }
        return this.waitForEvidence(frame,'默听摸北等待自摸或拔北按钮');
      }else{
        const center=stalledKitaButton(p,raw);
        if(center){
          await adapter.sendClick(raw,center,'ui');
          await this.record({kind:'auto_kita_fallback_click',action:'KITA Z4',frame:raw.id});
        }else if(raw.auto_kita?.verified&&!raw.auto_kita.enabled){
          this.autoKita??=new AutoKita();
          const sent=await this.autoKita.update(raw,adapter,{kitaDecision:true});
          if(sent)await this.record({kind:'auto_kita_enable_sent',frame:raw.id});
          if(this.autoKita.confirmedNow)await this.record({kind:'auto_kita_confirmed',frame:raw.id});
        }
        return performance.now()-p.started<3000?{status:'waiting_auto_kita_draw',frame:frame.id}:this.waitForEvidence(frame,'等待自动拔北和补摸');
      }
    }
    let handSynchronized=false;
    // Recover automatic extractions before manual detection or generic hand sync can erase
    // evidence for the original draw and leave only the replacement in history.
    let automaticSpan=null;
    if(GAME.sanma&&!this.snapshotEvent&&!this.kongDraw&&!session.pending&&!this.opening){
      let base=this.publicFrame;
      if(!base&&Number.isInteger(this.anchor.before.kita?.self?.count)&&frame.kita?.self?.count>this.anchor.before.kita.self.count&&this.anchor.decision?.output?.response?.startsWith('PLAY ')){
        const orig=this.anchor.before,r=orig.rivers?.self,cur=frame.rivers?.self,action=this.anchor.decision.output.response;
        if(r?.complete&&cur?.complete&&cur.tiles.length===r.tiles.length+1&&cur.tiles.at(-1)?.tile===action.split(' ')[1]&&
           cur.tiles.at(-1)?.color?.verified&&!cur.tiles.at(-1)?.tracking&&cur.tiles.at(-1)?.sideways===false&&
           r.tiles.every((t,i)=>t.tile===cur.tiles[i].tile&&t.sideways===cur.tiles[i].sideways)&&session.requests?.at(-1)?.state==='3 '+session.seat+' '+action){
          const hand=orig.hand.tiles.slice(),i=hand.findIndex(t=>t.tile===cur.tiles.at(-1).tile);
          if(i>=0){hand.splice(i,1);base={...orig,hand:{...orig.hand,tiles:hand},rivers:{...orig.rivers,self:cur}};}
        }
      }
      if(base&&Number.isInteger(base.kita?.self?.count)&&frame.kita?.self?.count>base.kita.self.count){
        const k=kitaTransition(base,frame,session);
        if(k?.verified)automaticSpan=k;
      }
    }
    // Check verified manual own actions BEFORE any brute-force hand overwrite so
    // riichi, melds, furiten discards, kongs, and kita stay strictly incremental in history.
    let pendingManualDecision=null;
    if(this.manualDecision){
      pendingManualDecision=this.manualDecision;
      this.manualDecision=null;
      if(pendingManualDecision.rinshanVerified)frame.rinshan_verified=true;
    }else if((frame.id??frame)!==this.manualAppliedFrame&&!this.kongDraw&&!automaticSpan&&!recoveredPon&&!session.pending&&!this.snapshotEvent){
      const baseFrame=this.publicFrame??manualActionBaseFrame(this.anchor,frame,session.seat);
      const manual=detectManualOwnAction(baseFrame,frame,session);
      if(manual?.kind==='wait_manual_selection')return {status:'waiting_manual_action',frame:frame.id,reason:manual.reason};
      if(manual?.verified)return this.applyManualOwnAction(manual,frame,{beforeFrame:baseFrame});
    }
    if(!this.special&&!this.adapter.call&&await this.updateAutoWin(frame)){
      return {status:this.autoInputStatus??'auto_win_sent'};
    }
    if(!pendingManualDecision&&!this.kongDraw&&!automaticSpan&&!recoveredPon&&!session.pending&&session.ledger?.hand&&typeof session.reconcileVisibleHand==='function'&&!frame.hand.rejected?.length&&
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
    const visibleTurn=!pendingManualDecision&&!recoveredPon&&frame.hand.tiles.length===14-3*frame.own_melds.groups.length&&!this.kongDraw&&!this.opening&&!this.snapshotEvent
      ?currentDecision(session,this.publicFrame??this.anchor.before,frame,recentObservation,{consumed:publicMode?[]:this.consumed,publicMode}):null;
    if(pendingManualDecision){span={requests:[pendingManualDecision.event],verified:true};publicMode=true;}
    else if(recoveredPon){span={requests:[recoveredPon],verified:true};publicMode=true;}
    else try{
      if(!frame.own_melds?.complete)throw Error('Incomplete own meld observation');
      if(automaticSpan){span=automaticSpan;publicMode=true;}
      else if(this.riichiPassive&&riichiDecisionPrompt(frame,session,adapter)&&visibleTurn){
        // Recover the intervening automatic turns from the declaration when available.
        // An already committed prefix must never be appended again.
        span=visibleTurn;publicMode=true;
        try{
          const full=riichiSpan(this.anchor.decision,this.anchor.before,frame).requests;
          const last=session.requests.findLastIndex(q=>q.state===`3 ${session.seat} ${this.anchor.decision.output.response}`);
          const prior=session.requests.slice(last+1);
          if(last>=0&&prior.every((q,i)=>q.state===full[i]?.state)&&full.at(-1)?.state===visibleTurn.requests.at(-1)?.state)span={verified:true,requests:full.slice(prior.length)};
        }catch{}
      }else if((handSynchronized||this.currentOnly)&&visibleTurn){
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
        const verified=kitaDraw&&raw===kitaDraw.frame?kitaDraw:
          verifyKongDraw(this.kongDraw.decision,this.kongDraw.before,frame,{localOnly:true});
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
          for(const position of GAME.opponents){
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
      const prompt=visiblePrompt,last=(outstanding.at(-1)??session.requests?.at(-1))?.state?.split(' ');
      if(prompt&&(!last||last[0]!=='3'||Number(last[1])!==prompt.round.seats[prompt.position]||
         !['PLAY','LIZHI','CHI','PENG'].includes(last[2])||last.at(-1)!==prompt.tile))
       throw Error('Visible call prompt belongs to a different discard');
      // Delayed controls are independent of the history path (including the
      // opening prefix). Reuse the committed event rather than rebuilding it.
      if(frame.controls?.PASS&&!outstanding.length){
        const event=session.requests?.at(-1);
        const key=`${session.requests?.length}:${event?.state}`;
        if(this.lastReactionKey===key)return {status:'observing'};
        if(/^3 [0-3] (PLAY|LIZHI|CHI|PENG|BUGANG|KITA) /.test(event?.state??'')){
          span={requests:[event],reuseObserved:true};publicMode=true;
          this.opening=null;this.openingConsumed=[];this.consumed=[];
          this.publicFrame=frame;
        }
      }
      if(!span.reuseObserved&&frame.controls?.PASS&&!/^3 [0-3] (PLAY|LIZHI|CHI|PENG|BUGANG|KITA) /.test(outstanding.at(-1)?.state??'')&&!outstanding.at(-1)?.state?.startsWith('2 '))
       throw Error('已识别操作按钮，尚未确认触发按钮的牌');
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

    if(this.recoveringEvidence){await this.record({kind:'evidence_recovered',frame:frame.id});this.recoveringEvidence=false;this.evidenceWaitReasons?.clear();this.evidenceWaitRetries?.clear();}
    this.unresolvedSince=null;
    if(span.estimated){
      span.requests=span.requests.map(q=>({...q,historyOrderCertain:false}));
      session.estimatedHistory={frameId:frame.id,assumptions:span.assumptions};
      await this.record({kind:'history_order_estimate',frame:frame.id,assumptions:span.assumptions,requests:span.requests});
    }
    const all=span.requests;
    const remaining=riichiEvents(this.opening?all.slice((this.openingConsumed??[]).length):publicMode?all:all.slice(this.consumed.length),span.reuseObserved?session.requests?.slice(0,-1):session.requests);
    if(!remaining.length){if(publicMode&&span.alignSnapshotRiver)this.publicFrame=frame;return {status:'observing'};}
    if(frame.controls?.PASS&&remaining.at(-1)?.state?.startsWith('3 ')&&!matchesCallButtons(frame,remaining.at(-1)))return {status:'retry_fresh_observation'};
    if(!span.reuseObserved)await this.reportVisibleEvents({...span,requests:remaining},frame,publicMode);
    const event=remaining.at(-1),own=event.state.startsWith('2 ')||!!recoveredPon||event.observedCallBeforeDiscard===true;
    if(span.reuseObserved&&this.lastReactionKey===`${session.requests?.length}:${event.state}`)return {status:'observing'};
    const reaction=!!frame.controls?.PASS&&/^3 [0-3] (PLAY|LIZHI|CHI|PENG|BUGANG|KITA) /.test(event.state)&&!event.observedCallBeforeDiscard;
    // Sanma dama-tenpai north draw: client does NOT auto-extract Z4 while dama tenpai.
    // Bypass the decision engine completely: click TSUMO if offered, otherwise click KITA,
    // and only enter normal decision once the replacement draw is neither winning nor Z4.
    if(event.state.startsWith('2 ')&&!recoveredPon&&!event.observedCallBeforeDiscard){
      const damaNorth=isDamaTenpaiNorthDraw(frame,{
        riichi:this.riichiPassive===true,
        history:session.requests,
        draw:event.state.split(' ')[1],
        kokushiRouteActive:adapter.kokushiRoute?.active===true,
      });
      if(damaNorth){
        const tsumoCenter=tsumoButtonCenter(raw);
        if(tsumoCenter){
          await adapter.sendClick(raw,tsumoCenter,'ui');
          await this.record({kind:'dama_north_tsumo_click',frame:raw.id});
          this.waitForAutomaticNorth(frame,span.reuseObserved?[]:remaining,{damaNorth:true,northWaits:damaNorth.northWaits,tsumoClickedAt:performance.now()});
          return {status:'waiting_win_settlement',frame:raw.id};
        }
        this.waitForAutomaticNorth(frame,span.reuseObserved?[]:remaining,{damaNorth:true,northWaits:damaNorth.northWaits});
        const act=damaNorthAction(this.automaticNorth,raw);
        if(act?.kind==='kita'){
          await adapter.sendClick(raw,act.center,'ui');
          await this.record({kind:'dama_north_kita_click',frame:raw.id});
          return {status:'dama_north_kita_sent',frame:raw.id};
        }
        return {status:'waiting_dama_north_button',frame:raw.id};
      }
      if(frame.rinshan_verified&&tsumoButtonCenter(raw)){
        await adapter.sendClick(raw,tsumoButtonCenter(raw),'ui');
        await this.record({kind:'dama_north_tsumo_click',frame:raw.id});
        return {status:'waiting_win_settlement',frame:raw.id};
      }
    }
    // Four-stage auto-win guard: intercept suspected tsumo/ron before decision engine;
    // wait silently, verify/enable auto-win, force full hand rescan if unsettled, or idle the round.
    if(!recoveredPon&&!event.observedCallBeforeDiscard){
      const guard=await this.autoWinGuard.evaluate(frame,{
        session,
        adapter,
        reactionEvent:(!own&&/^3 [0-3] (PLAY|LIZHI|CHI|PENG) /.test(event.state))?event:null,
        riichi:this.riichiPassive===true,
        record:e=>this.record(e),
      });
      if(guard.action==='wait')return {status:guard.status,winKind:guard.winKind,frame:frame.id};
      if(guard.action==='auto_win_toggle')return {status:guard.status,frame:frame.id};
      if(guard.action==='idle')return {status:guard.status,frame:frame.id};
      if(guard.action==='recovered'&&guard.rescanned)return this.stepOnce(guard.rescanned);
    }
    if(!own&&!reaction){
      if(publicMode||span.verified||span.gameConfirmed){session.observeVerified({verified:true,requests:remaining},frame.hand.tiles.map(t=>t.tile));this.observedTail=newObservedTail(session,frame);this.snapshotEvent=null;if(this.opening)this.openingConsumed=all.map(r=>r.state);this.publicFrame=frame;this.consumed=[];await this.record({kind:'public_events',frame:frame.id,requests:remaining});}
      return {status:'observing'};
    }
    const melds=recoveredPon||event.observedCallBeforeDiscard?[]:canonicalMelds(frame,'self',frame.own_melds);
    const ownDraw=event.state.startsWith('2 ');
    const request=recoveredPon||event.observedCallBeforeDiscard?event:visibleActions(frame,event,melds,{riichi:this.riichiPassive===true,history:session.requests});
    const lockedKong=own&&this.riichiPassive&&riichiKongTile(frame,session.requests);
    const lockedPrompt=own&&this.riichiPassive&&riichiDecisionPrompt(frame,session,adapter);
    if(lockedKong)request.validact=request.validact.split(',').map(a=>a.startsWith('ANGANG ')?'ANGANG '+lockedKong:a).join(',');
    const previous=remaining.slice(0,-1);
    const hand=frame.hand.tiles.map(t=>t.tile);
    // On turn 1 (or right after a deal/slide), Mahjong Soul may briefly display an unsorted
    // concealed hand before auto-sorting ~0.5s later. Clicking stale unsorted coordinates after
    // a 2s search discards the wrong tile. Wait up to 1500ms for sorting to finish first.
    if(ownDraw&&hand.length>=3&&(adapter.captureSource||this.waitForUnsortedHand)&&!isConcealedHandSorted(hand.slice(0,-1))){
      const sortKey=JSON.stringify([roundIdentity(frame),hand.slice().sort()]);
      if(this.unsortedHandKey!==sortKey){
        this.unsortedHandKey=sortKey;
        this.unsortedHandSince=performance.now();
      }
      if(performance.now()-this.unsortedHandSince<1500){
        return this.waitForEvidence(frame,'起手手牌尚未理牌完成，等待理牌后决策');
      }
    }else{
      this.unsortedHandKey=null;
      this.unsortedHandSince=null;
    }
    let probeAbort=null;
    if(ownDraw){
      this.drawControlWindow??=new OwnDrawControlWindow();
      this.drawControlWindow.begin(frame,raw.controls);
    }else{
      this.drawControlWindow?.reset();
    }
    // One atomic public prefix before the decision; own draw is applied only
    // by decide(), never appended a second time by the observation loop.
    const expected=frame.hand.tiles.map(t=>t.tile);
    if(recoveredPon)expected.splice(0,expected.length,...this.ponWatch.decision.visibleHand);
    else if(event.observedCallBeforeDiscard)expected.splice(0,expected.length,...(session.ledger?.hand??[]));
    else if(own)expected.pop();
    const checkpoint={requests:session.requests?.slice(),responses:session.responses?.slice(),ledger:structuredClone(session.ledger)};
    let decision,recognized,latestBeforeSearch=adapter.latest;
    try{
      if(!adapter.kokushiRoute?.active&&ownDraw&&automaticNorthDraw(frame,adapter.autoKitaOutput,event.state.split(' ')[1]))
        return this.waitForAutomaticNorth(frame,span.reuseObserved?[]:remaining);
      session.observeVerified({verified:true,requests:previous},expected);
      if(recoveredPon&&!this.ponWatch.reported){
        await this.record({kind:'default_action_replacement',decisionId:this.ponWatch.decision.input.call_search.id,requested:'PASS',actual:event.state.split(' ').slice(2).join(' '),frame:frame.id});
        this.ponWatch.reported=true;
      }
      recognized=performance.now();
      latestBeforeSearch=adapter.latest;
      if(ownDraw&&typeof adapter.probeControls==='function'){
        const preview=decisionPolicy(request,session.context,session.seat,frame,[...(session.requests??[]),request],hand,adapter.kokushiRoute);
        const targetValidact=preview.request.validact;
        if(missingControlsForValidact(targetValidact,this.drawControlWindow.controls).length>0){
          probeAbort=new AbortController();
          const {signal}=probeAbort;
          const windowRef=this.drawControlWindow;
          const startKey=windowRef.key;
          let seq=adapter.captureSequence??0;
          void (async()=>{
            while(!signal.aborted&&windowRef.key===startKey&&missingControlsForValidact(targetValidact,windowRef.controls).length>0){
              const probed=await adapter.probeControls(seq,{signal});
              if(!probed||signal.aborted||windowRef.key!==startKey)break;
              if(Number.isInteger(probed.sequence))seq=probed.sequence;
              if(probed.controls)windowRef.observeControls(probed.controls);
              if(probed.auto_win?.verified)raw.auto_win=probed.auto_win;
              if(probed.auto_kita?.verified)raw.auto_kita=probed.auto_kita;
            }
          })().catch(()=>{});
        }
      }
      decision=await session.decide(request,hand,{reuseObserved:!!span.reuseObserved,signal:this.signal});
    }catch(error){
      // No mouse input has been issued. Retrying a failed calculation must
      // not append the same observed public prefix again.
      if(!session.pending)Object.assign(session,checkpoint);
      if(error.name==='AbortError'||this.signal?.aborted)return {status:'stopped',pending:!!(this.pending||this.special)};
      if(error.code==='AUTO_KITA_PENDING')return this.waitForAutomaticNorth(frame,span.reuseObserved?[]:remaining);
      if(error.code==='BOT_INVALID_RESULT'){
        // The checkpoint above preserves the verified history for a fresh retry.
        await this.record({kind:'invalid_bot_result',frame:frame.id,reason:error.message});
        return {status:'retry_fresh_observation'};
      }
      throw error;
    }finally{
      probeAbort?.abort();
    }
    if(this.signal?.aborted){
      decision.callSearch?.cancel();
      session.pending=null;Object.assign(session,checkpoint);adapter.call=null;
      return {status:'stopped',pending:!!(this.pending||this.special)};
    }
    decision.observationId=frame.id;
    // If a newer frame arrived during search whose hand already changed (e.g. user acted manually),
    // abort before sending stale input so the next step ingests the manual action cleanly.
    // If the multiset is identical but tiles were re-ordered (e.g. client finished auto-sort mid-search),
    // refresh the click target coordinates from adapter.latest so we never click a stale slot.
    if(adapter.latest&&adapter.latest!==latestBeforeSearch&&adapter.latest!==raw&&adapter.latest.hand?.complete){
      const latestTiles=adapter.latest.hand.tiles.map(t=>t.tile);
      if(JSON.stringify(latestTiles.slice().sort())!==JSON.stringify(hand.slice().sort())){
        decision.callSearch?.cancel();
        session.pending=null;Object.assign(session,checkpoint);adapter.call=null;
        await this.afterDecisionInput?.();
        await this.record({kind:'input_rejected_before_down',decisionId:decision.input?.call_search?.id,action:decision.output.response,reason:'搜索期间画面手牌已变化，撤销旧决策并衔接最新状态'});
        return {status:'retry_fresh_observation'};
      }
      if(JSON.stringify(latestTiles)!==JSON.stringify(hand)){
        raw=adapter.latest;
        decision.observationId=adapter.latest.id;
      }
    }
    this.ponWatch=GAME.sanma&&reaction&&decision.output.response==='PASS'&&frame.controls.PENG?{decision,before:frame}:null;
    if(lockedPrompt)decision.riichiKongPrompt=true;
    if(ownDraw){
      const execPlan=resolveOwnDrawExecution(decision,this.drawControlWindow.controls,{
        validact:decision.input?.requests?.at(-1)?.validact??'',
        hand,
        locked:declaredSeats(decision.input?.requests??session.requests).has(session.seat),
        draw:event.state.trim().split(/\s+/)[1]??null,
      });
      if(execPlan.mode==='button'){
        raw.controls=this.drawControlWindow.mergedControls(raw.controls);
      }else if(execPlan.mode==='degrade_play'){
        decision.output={...decision.output,response:execPlan.actual,degraded_from:execPlan.requested,degraded_reason:execPlan.reason};
        session.pending=decision;
        if(decision.telemetry)decision.telemetry={...decision.telemetry,response:execPlan.actual};
        await this.record({kind:'action_degraded_no_button',decisionId:decision.input?.call_search?.id,frame:frame.id,requested:execPlan.requested,actual:execPlan.actual,reason:execPlan.reason});
      }else if(execPlan.mode==='auto_kita'){
        decision.autoKitaFallback=true;
        await this.record({kind:'action_degraded_no_button',decisionId:decision.input?.call_search?.id,frame:frame.id,requested:execPlan.requested,actual:'AUTO_KITA',reason:execPlan.reason});
      }
    }
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
        await this.record({kind:error.inputNotSent?'input_rejected_before_down':'input_outcome_unconfirmed',decisionId:decision.input?.call_search?.id,action:decision.output.response,reason:error.message});
        return {status:'retry_fresh_observation'};
      }
      if(error.outputOutcomeUnknown){
        const transaction={decision,before:frame,started:start,sentAt:performance.now(),riverObservations:this.riverObservations};
        this.special=transaction;
        this.opening=null;this.snapshotEvent=null;this.consumed=all.map(r=>r.state);
        await this.record({kind:'input_outcome_unconfirmed',decisionId:decision.input?.call_search?.id,action:decision.output.response,reason:error.message,stageRetained:true});
        return {status:'retry_fresh_observation'};
      }
      if(!error.inputNotSent)throw error;
      // Proven pre-down rejection: no game input happened. Roll back only
      // this decision, then obtain a fresh observation before trying again.
      decision.callSearch?.cancel();
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
      await this.record({kind:'input_rejected_before_down',decisionId:decision.input?.call_search?.id,action:decision.output.response,reason:error.message});
      return {status:'retry_fresh_observation'};
    }finally{await this.afterDecisionInput?.();}
    const sent=performance.now();
    if(reaction)this.lastReactionKey=`${decision.input?.requests?.length??session.requests?.length}:${event.state}`;
    this.kongDraw=null;
    this.rinshanFrame=null;
    this.opening=null;
    this.snapshotEvent=null;
    this.consumed=all.map(r=>r.state);this.actions++;
    const kind=decision.output.response.split(' ')[0];
    if(receipt?.autoKita&&receipt.notSent)await this.record({kind:'input_rejected_before_down',action:decision.output.response,reason:receipt.notSent});
    if(receipt?.autoKita&&receipt.sent)await this.record({kind:'auto_kita_enable_sent',frame:frame.id});
    if(receipt?.autoKita&&receipt.confirmedNow)await this.record({kind:'auto_kita_confirmed',frame:frame.id});
    await this.record({kind:receipt?.autoKita&&!receipt.sent&&!receipt.manual?'auto_kita_waiting_effect':'input',telemetry:decision.telemetry,action:decision.output.response,frame:frame.id,...frame.timing,decisionMs:decided-recognized,operationMs:sent-decided,totalMs:sent-start,withinBudget:sent-start<=5000,receipt});
    if(!['PLAY','PASS'].includes(kind)){
      if(['LIZHI','CHI','PENG','GANG','ANGANG','BUGANG','KITA'].includes(kind)){this.special={decision,before:frame,started:start,sentAt:sent,riverObservations:this.riverObservations};return {status:'special_started',action:decision.output.response};}
      return {status:'special_pending',action:decision.output.response};
    }
    this.pending={decision,before:frame,inputFrame:structuredClone(raw),started:start,publicMode,sentAt:performance.now()};
    return {status:'input_sent',action:decision.output.response};
  }
  async run({milliseconds=45000,maxActions=6,signal}={}){
    this.signal=signal??null;
    const end=performance.now()+milliseconds,initial=this.actions;
    // Do not yield between the call/riichi button and its required discard.
    // A bounded grace period finishes the transaction without starting an
    // unrelated decision after the requested run boundary.
    while(!signal?.aborted&&((performance.now()<end&&this.actions-initial<maxActions)||(this.special&&performance.now()<end+8000))){
      if(signal?.aborted)return {status:'stopped',pending:!!(this.pending||this.special)};
      let result;
      try{result=await this.step();this.transientFailure=null;}catch(error){
        if(error.name==='AbortError'||signal?.aborted)return {status:'stopped',pending:!!(this.pending||this.special)};
        if(error.outputOutcomeUnknown){
          const p=this.pending??this.special;
          if(this.pending){
            // PLAY/PASS already have a visual-confirmation path. An uncertain
            // retry receipt must not detach that transaction into a dead end.
            await this.record({kind:'input_outcome_unconfirmed',decisionId:p.decision.input?.call_search?.id,action:p.decision.output.response,reason:error.message});
          }
          else if(p){await this.record({kind:'input_outcome_unconfirmed',decisionId:p.decision.input?.call_search?.id,action:p.decision.output.response,reason:error.message,stageRetained:true});}
          else if(error.autoWinOutputPending){await this.record({kind:'auto_win_input_outcome_unconfirmed',reason:error.message});}
          else if(error.autoKitaOutputPending){await this.record({kind:'auto_kita_input_outcome_unconfirmed',reason:error.message});}
          else throw error;
        }
        if(!error.outputOutcomeUnknown&&!error.inputNotSent&&!/Recognition timeout|Bound game must (?:be foreground and not|not be) minimized|Native capture timeout/.test(error.message))throw error;
        if(this.transientFailure!==error.message){await this.record({kind:'recoverable_runtime_wait',reason:error.message});this.transientFailure=error.message;}
        if(error.message!=='Recognition timeout')await delay(250);
        continue;
      }
      if(['hand_ended','match_ended','round_boundary'].includes(result.status))return result;
      if(result.status==='stopped'||signal?.aborted)return {status:'stopped',pending:!!(this.pending||this.special)};
    }
    if(signal?.aborted)return {status:'stopped',pending:!!(this.pending||this.special)};
    return {status:'checkpoint',actions:this.actions-initial,pending:!!(this.pending||this.special)};
  }
}
