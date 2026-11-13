import {decisionMetrics} from './decision-metrics.mjs';
import {actualCall,sameCall} from './actual-call.mjs';
import {CallSequence} from './call-sequence.mjs';
import {canonicalMelds} from './meld-events.mjs';
import {verifyDiscard,verifyLocalDiscard,verifyCalledDiscard,replacedDiscard} from './discard-verification.mjs';
import {ownRiichiAccepted} from './riichi-acceptance.mjs';
import {riichiSpan} from './riichi-span.mjs';
import {chainedCallSpan} from './chained-call-span.mjs';
import {verifyKongDraw} from './kong-transition.mjs';
import {trackOccludedRivers,RiverObservationCache,MeldObservationCache} from './river-tracking.mjs';
import {postCallAnchor} from './post-call-anchor.mjs';
import {retryUnchangedRiichi} from './riichi-recovery.mjs';
import {changedRound} from './round-boundary.mjs';
import {sameReactionWindow} from './reaction-window.mjs';

// Continues one bot decision through the client's staged UI. Does not decide
// again, repeat a sent input, or treat an input receipt as completion.
export async function advanceStaged(adapter,session,pending){
 let result;
 try{result=await advanceStage(adapter,session,pending);}catch(error){
  if(error.outputOutcomeUnknown)return {status:'waiting_special_frame',reason:'点击回执未知，保留阶段并识别实际效果'};
  if(error.inputNotSent)return {status:'waiting_special_frame',reason:'点击前被拒绝，保留阶段并用新画面重试'};
  if(error.message!=='Recognition timeout')throw error;
  result={status:'waiting_special_frame',reason:'动画期间识别超时，保留操作阶段继续识别'};
 }
 if(result.status.startsWith('waiting_')){
  pending.waitingSince??=performance.now();
 }else delete pending.waitingSince;
 return result;
}

async function advanceStage(adapter,session,pending){
 const kind=pending.decision.output.response.split(' ')[0];
 const phaseTwo=['CHI','PENG'].includes(kind);
 if(phaseTwo)pending.discardStageStarted??=pending.sentAt??performance.now();
 const kong=['GANG','ANGANG','BUGANG','KITA'].includes(kind);
 if(!kong&&!['LIZHI','CHI','PENG'].includes(kind))return {status:'special_pending',action:pending.decision.output.response};
 const call=adapter.call;
 if(!call||call.uncertain)throw Error('Staged transaction missing or uncertain');
 let sequence=call.sequence;
 if(kind==='LIZHI'&&call.riichiBatch&&!pending.discardDecision){
  pending.discardBefore=pending.before;
  pending.discardDecision={output:{response:pending.decision.output.response},visibleHand:[...pending.decision.visibleHand]};
 }
 const retryDiscard=call.lastInput&&['discard','selection'].includes(call.lastInput.phase)&&!kong;
 const selecting=kind==='LIZHI'?sequence.phase==='selection':!kong&&['await_meld','await_choice_effect'].includes(sequence.phase);
 const meldCount=pending.before.hand.meld_count+(['LIZHI','BUGANG','KITA'].includes(kind)?0:1);
 const frame=await adapter.inspect({meld_count:meldCount,phase:'auto',auto_meld_count:true,observeSettlement:true,...(kind==='LIZHI'?{readTableScores:true}:{}),...(selecting||retryDiscard||call.riichiBatch?{selection_overlay:kind==='LIZHI'?'riichi':'post_call'}:{})});
 // Staged calls bypass the ordinary observation loop. Keep their confirmed
 // melds too, including the short post-call frame before the group slides.
 if(!pending.meldObservations){
  pending.meldObservations=new MeldObservationCache();
  pending.meldObservations.apply(pending.before);
 }
 if(pending.discardBefore)Object.assign(pending.discardBefore,pending.meldObservations.apply(pending.discardBefore));
 Object.assign(frame,pending.meldObservations.apply(frame));
 pending.latest=frame;
 if(frame.terminal_phase?.name==='match_end')return {status:'match_ended',frame:frame.id,pendingAction:pending.decision.output.response};
 if(frame.settlement?.complete)return {status:'waiting_special_settlement',frame:frame.id};
 const boundary=changedRound(pending.before,frame);
 if(boundary)return {status:'round_boundary',frame:frame.id,...boundary,pendingAction:pending.decision.output.response};
 if(kind==='ANGANG'&&pending.decision.riichiKongPrompt&&frame.own_melds?.complete&&!frame.own_melds.tracking){
  // After riichi the replacement tile can be discarded before the next capture.
  // The added concealed kong itself proves this action; no replacement click is needed.
  const target=pending.decision.output.response.split(' ')[1],norm=t=>t.replace(/0$/,'5');
  const before=pending.before.own_melds.groups,now=frame.own_melds.groups;
  const matches=g=>g.kind==='ANGANG'&&g.tiles.length===4&&g.tiles.every(t=>norm(t)===norm(target));
  if(frame.round?.seat_identity?.verified&&now.length===before.length+1&&!before.some(matches)&&now.some(matches)){
   await session.confirm(pending.decision.output.response);adapter.call=null;
   return {status:'locked_kong_confirmed',decision:pending.decision,before:pending.before,frame};
  }
 }
 if(kind==='KITA'&&pending.decision.riichiKongPrompt&&frame.round?.seat_identity?.verified){
  const prior=pending.before.kita?.self?.count,strip=frame.kita?.self;
  const seen=strip?.count_source==='same_round_confirmed_count'?strip.observed_count:strip?.count;
  if(Number.isInteger(prior)&&seen===prior+1){
   await session.confirm(pending.decision.output.response);adapter.call=null;
   adapter.kitaEvidence?.observe(frame);
   return {status:'locked_kong_confirmed',decision:pending.decision,before:pending.before,frame};
  }
 }
 if(kind==='LIZHI'){
  if(ownRiichiAccepted(pending.before,frame,sequence.tile)||
     (pending.riichiScoreBefore&&ownRiichiAccepted(pending.riichiScoreBefore,frame,sequence.tile)))pending.riichiAccepted=true;
  if(selecting&&!pending.discardDecision&&frame.table_scores?.complete&&
     frame.round?.counters?.riichi_sticks===pending.before.round?.counters?.riichi_sticks&&
     JSON.stringify(frame.hand?.tiles.map(t=>t.tile).sort())===JSON.stringify(pending.decision.visibleHand.slice().sort()))
    pending.riichiScoreBefore=structuredClone(frame);
 }
 (pending.checkpoints??=[]).push(frame);
 if(pending.checkpoints.length>128)pending.checkpoints.splice(0,pending.checkpoints.length-128);
 if(!frame.hand?.complete||frame.hand.rejected?.length)return {status:'waiting_special_frame'};
 if(kind==='KITA'){
  const oldCount=pending.before.kita?.self?.count,strip=frame.kita?.self;
  const count=strip?.count_source==='same_round_confirmed_count'?strip.observed_count:strip?.count;
  const old=pending.before.rivers?.self,now=frame.rivers?.self;
  if(Number.isInteger(oldCount)&&count===oldCount&&old?.complete&&now?.complete&&
     now.tiles.length===old.tiles.length+1&&old.tiles.every((t,i)=>t.tile===now.tiles[i].tile)){
   const tile=now.tiles.at(-1);
   if(tile.color?.verified&&!tile.tracking&&tile.sideways===false){
    const actual='PLAY '+tile.tile,decision={...pending.decision,output:{...pending.decision.output,response:actual}};
    let proof;
    try{proof=verifyLocalDiscard(decision,pending.before,frame);}catch{}
    if(proof){
     const requested=pending.decision.output.response;
     session.pending={...session.pending,output:{...session.pending.output,response:actual}};
     await session.confirm(actual);adapter.call=null;pending.decision=decision;
     await pending.reportReplacement?.(requested,actual);
     return {status:'special_confirmed',frame:frame.id,nextDraw:proof.nextDraw,
      anchor:{decision,before:pending.before},totalMs:performance.now()-pending.started};
    }
   }
  }
 }
 // Confirm a replacement draw before considering retry: extracting North
 // and drawing North again leaves the sorted hand unchanged.
 let kongFailure;
 if(kong){
  let transition;
  try{transition=verifyKongDraw(pending.decision,pending.before,frame);}catch{
   try{transition=verifyKongDraw(pending.decision,pending.before,frame,{localOnly:true});}
   catch(error){kongFailure=error;}
  }
  if(transition){
   sequence.verify(transition.metadata);
   await session.confirm(pending.decision.output.response);adapter.call=null;
   adapter.kitaEvidence?.observe(transition.frame);
   return {status:'kong_confirmed',...transition,decision:pending.decision,before:pending.before};
  }
 }
 // A fresh unchanged legal prompt proves that an uncertain click had no
 // effect. Retry that stage only; otherwise keep observing its effect.
 const unknown=call.lastInput??(call.receiptUnknown&&call.unknownInput);
 if(unknown&&unknown.frame.id!==frame.id&&frame.own_melds?.complete&&
    JSON.stringify(frame.hand.tiles.map(t=>t.tile).sort())===JSON.stringify(unknown.frame.hand.tiles.map(t=>t.tile).sort())&&
    JSON.stringify(canonicalMelds(frame,'self',frame.own_melds))===JSON.stringify(canonicalMelds(unknown.frame,'self',unknown.frame.own_melds))){
  const sameWall=Number.isInteger(unknown.frame.round?.remaining?.value)&&
    unknown.frame.round.remaining.value===frame.round?.remaining?.value;
  const priorNorth=unknown.frame.kita?.self,nowNorth=frame.kita?.self;
  const freshNorth=v=>v?.count_source==='same_round_confirmed_count'?v.observed_count:v?.count;
  const northConflict=Number.isInteger(priorNorth?.count)&&[nowNorth?.count,freshNorth(nowNorth)].some(n=>Number.isInteger(n)&&n!==priorNorth.count);
  const retryEffectUnchanged=!kong||(sameWall&&(kind!=='KITA'||!northConflict));
  const button=retryEffectUnchanged&&['call','button'].includes(unknown.phase)&&!!(frame.controls?.[kind]||(kind==='ANGANG'&&frame.controls?.GANG))&&
    (kind==='LIZHI'||kind==='ANGANG'||kind==='BUGANG'||kind==='KITA'||sameReactionWindow(unknown.frame,frame));
  const discard=(['discard','selection'].includes(unknown.phase)||(kind==='LIZHI'&&call.riichiBatch))&&!kong&&frame.selection?.verified&&
    frame.selection.legalDiscards?.includes(kind==='LIZHI'?sequence.tile:sequence.discard);
  const choice=['await_meld','selection'].includes(unknown.phase)&&frame.call_choices?.verified&&unknown.frame.call_choices?.verified&&
    JSON.stringify(frame.call_choices.choices)===JSON.stringify(unknown.frame.call_choices.choices);
  if(button||discard||choice){
   sequence.phase=discard&&kind==='LIZHI'?'selection':unknown.phase;
   const receipt=await adapter.continueCall(frame,{verified:true,observationId:frame.id,seats:frame.round.seat_identity.seats,melds:canonicalMelds(frame,'self',frame.own_melds)});
   return {status:'special_button_retried',frame:frame.id,receipt,totalMs:performance.now()-pending.started};
  }
 }
 if(!kong&&kind!=='LIZHI'&&frame.call_choices?.verified){
  // The initial call and choice are sent together. A fresh surviving choice
  // prompt proves that the second click did not take effect; retry only it.
  if(sequence.phase==='await_choice_effect')sequence.phase='await_meld';
  if(sequence.phase!=='await_meld')throw Error('Unexpected combination selection');
  const prior=pending.before.round;
  if(JSON.stringify(frame.hand.tiles.map(t=>t.tile).sort())!==JSON.stringify(pending.decision.visibleHand.slice().sort()))return {status:'waiting_special_frame'};
  if(!frame.own_melds?.complete)return {status:'waiting_special_melds'};
  if(frame.round?.wind!==prior.wind||frame.round?.hand_number?.value!==prior.hand_number.value||frame.round?.counters?.honba!==prior.counters.honba)return {status:'waiting_special_seats'};
  const choiceMelds=canonicalMelds({...frame,round:{...frame.round,seat_identity:prior.seat_identity}},'self',frame.own_melds);
  const receipt=await adapter.continueCall(frame,{verified:true,observationId:frame.id,seats:prior.seat_identity.seats,melds:choiceMelds});
  return {status:'special_choice_sent',frame:frame.id,receipt,totalMs:performance.now()-pending.started};
 }
 if(kong){
  if(sequence.phase==='selection'&&frame.call_choices?.verified&&frame.own_melds?.complete){
   const receipt=await adapter.continueCall(frame,{verified:true,observationId:frame.id,seats:frame.round.seat_identity.seats,melds:canonicalMelds(frame,'self',frame.own_melds)});
   return {status:'special_choice_sent',frame:frame.id,receipt,totalMs:performance.now()-pending.started};
  }
  return {status:'waiting_kong_effect',reason:kongFailure?.message};
 }
 // A selection overlay can cover seat glyphs. Seats are invariant during
 // this already-started transaction, but only reuse them if round identity
 // and the exact pre-action hand still agree with the verified input.
 let meldFrame=frame;
 if(!frame.round?.seat_identity?.verified){
  const prior=pending.before;
  const sameHand=JSON.stringify(frame.hand.tiles.map(t=>t.tile).sort())===JSON.stringify(pending.decision.visibleHand.slice().sort());
  const sameRound=frame.round?.wind===prior.round?.wind&&frame.round?.hand_number?.value===prior.round?.hand_number?.value&&frame.round?.counters?.honba===prior.round?.counters?.honba;
  if(!selecting||!sameHand||!sameRound||!prior.round?.seat_identity?.verified)return {status:'waiting_special_seats'};
  meldFrame={...frame,round:{...frame.round,seat_identity:prior.round.seat_identity}};
 }
 if(!frame.own_melds?.complete)return {status:'waiting_special_melds'};
 const metadata={verified:true,observationId:frame.id,seats:meldFrame.round.seat_identity.seats,melds:canonicalMelds(meldFrame,'self',frame.own_melds)};
 if(selecting){
    let verifiedDiscardResult;
    if(!frame.selection?.verified){
      if(kind==='LIZHI'&&frame.selection?.tiles?.length&&frame.selection.tiles.every(t=>t.enabled===true)){
        const retry=await retryUnchangedRiichi(adapter,pending);
        if(retry)return retry;
      }
      return {status:'waiting_special_selection'};
    }
    if(kind!=='LIZHI'){
      const actual=actualCall(pending.decision,pending.before,meldFrame);
      if(actual){
        const stream=pending.decision.callSearch;
        if(!sameCall(actual.response,pending.decision.output.response)){
          if(!stream)throw Object.assign(Error('实际鸣牌组合与预期不同；当前听风不支持组合纠正，已禁止执行旧弃牌结果'),{code:'CALL_CORRECTION_UNSUPPORTED',actualCall:actual});
          const expected=pending.decision.output.response;
          stream.correct(actual);
          pending.decision.output={...pending.decision.output,response:actual.response};
          sequence=new CallSequence(actual.response,{verified:true,hand:pending.decision.visibleHand,melds:canonicalMelds(pending.before,'self',pending.before.own_melds),allowDeferredDiscard:true},pending.decision.ledger.lastPlayer);
          sequence.inputSent();call.sequence=sequence;
          pending.callObserved=true;pending.discardBefore=null;pending.discardDecision=null;
          return {status:'call_combination_corrected',frame:frame.id,expected,actual:actual.response};
        }
        if(stream){
          if(!pending.callObserved){stream.confirmCall(actual);pending.callObserved=true;}
          if(stream.state.status==='failed'||stream.state.status==='cancelled')throw Error(stream.state.error??'Call search cancelled');
          if(stream.state.status!=='ready')return {status:'waiting_call_discard',frame:frame.id};
          const result=stream.state.result,tile=result.response.split(' ')[1];
          if(!actual.hand_tiles.includes(tile)||!actual.legal_discards.includes(tile)){
            // Fresh legal-discard evidence invalidates this revision. The
            // engine must search the actual call with the supplied legal set.
            stream.correct(actual);
            return {status:'waiting_call_discard',frame:frame.id,reason:'discard_not_legal_in_actual_call'};
          }
          verifiedDiscardResult=result;
          pending.discardSearchMs=result.elapsed_ms;
          sequence.discard=tile;
          pending.decision.output={...pending.decision.output,response:actual.response+' '+tile};
          pending.decision.telemetry=result.telemetry??null;
          if(stream.stderr)pending.decision.metrics=decisionMetrics(stream.stderr,result.response,pending.decision.input);

        }
      }
    }
    let discardBefore;
    try{discardBefore=kind==='LIZHI'?trackOccludedRivers(pending.before,frame):postCallAnchor(pending.decision,pending.before,meldFrame);}
    catch(error){return {status:'waiting_special_public_proof',reason:error.message};}
    const result=verifiedDiscardResult;
    if(result&&sequence.discard===result.response.split(' ')[1]&&(!Object.hasOwn(pending,'announcedDiscardRevision')||pending.announcedDiscardRevision!==result.revision)){
      await pending.reportDiscardDecision?.(result.response,pending.decision.metrics,discardBefore,result.telemetry);
      pending.announcedDiscardRevision=result.revision;
    }
    if(discardBefore.acceptedRiichi)adapter.acceptRiichi(discardBefore.acceptedRiichi);
  const operationStarted=performance.now();
  // Keep the original observation for the adapter's latest-frame identity
  // check; retain sourced temporal tracking only in the subsequent anchor.
    pending.discardBefore=discardBefore;
  pending.discardDecision={output:{response:kind==='LIZHI'?pending.decision.output.response:'PLAY '+sequence.discard},visibleHand:frame.hand.tiles.map(t=>t.tile)};
  const receipt=await adapter.continueCall(frame,metadata);
  return {status:'special_discard_sent',frame:frame.id,receipt,...frame.timing,decisionMs:pending.discardSearchMs??0,operationMs:performance.now()-operationStarted,totalMs:performance.now()-(phaseTwo?pending.discardStageStarted:pending.started)};
 }
 if(!pending.discardBefore)throw Error('Missing staged discard evidence');
 // Effect confirmation needs the same sourced river tracking as ordinary
 // turns. Keep the raw frame for adapter identity/input checks; tracked
 // evidence is never promoted to a fresh visual recognition.
 if(!pending.riverObservations){
  pending.riverObservations=new RiverObservationCache();
  pending.riverObservations.apply(pending.before);
 }
 const evidenceFrame=pending.riverObservations.apply(frame);
 pending.effectEvidence=evidenceFrame;
 const effectBefore=kind==='LIZHI'?pending.before:pending.discardBefore;
 const replacement=replacedDiscard(pending.discardDecision,effectBefore,evidenceFrame);
 if(replacement){
  if(kind==='LIZHI'&&pending.riichiAccepted){
   replacement.actual='LIZHI '+replacement.actual.split(' ')[1];
   replacement.decision={...replacement.decision,output:{...replacement.decision.output,response:replacement.actual}};
  }
  await pending.reportReplacement?.(replacement.requested,replacement.actual);
  pending.discardDecision=replacement.decision;
  const response=kind==='LIZHI'?replacement.actual:pending.decision.output.response.split(' ').slice(0,-1).concat(replacement.actual.split(' ')[1]).join(' ');
  pending.decision={...pending.decision,output:{...pending.decision.output,response}};
  session.pending={...session.pending,output:{...session.pending?.output,response}};
  if(kind!=='LIZHI')sequence.discard=replacement.actual.split(' ')[1];
 }
 const riichi= pending.discardDecision.output.response.startsWith('LIZHI ');
 let verified;
 // Riichi selection is a fast hand-only observation with no river. Use the
 // complete pre-declaration frame to verify its discard and unchanged hand.
 try{verified=verifyDiscard(pending.discardDecision,kind==='LIZHI'?pending.before:pending.discardBefore,evidenceFrame);}catch{
  try{verified=verifyLocalDiscard(pending.discardDecision,effectBefore,evidenceFrame,{currentDraw:true,ownRiichi:pending.riichiAccepted===true});}catch{}
  if(!verified){
  if(kind!=='LIZHI'){
   try{verified=verifyCalledDiscard(pending.discardDecision,pending.discardBefore,evidenceFrame);}catch{return {status:'waiting_special_effect'};}
  }else{
  try{verified=riichiSpan(pending.decision,pending.before,evidenceFrame).confirmation;}catch{
   try{verified=chainedCallSpan(pending.decision,pending.before,evidenceFrame,{checkpoints:pending.checkpoints}).confirmation;}catch(error){return {status:'waiting_special_effect',reason:error.message};}
  }
  }
  }
 }
 if(riichi&&!pending.riichiAccepted&&frame.round.counters.riichi_sticks!==pending.before.round.counters.riichi_sticks+1&&
    !frame.rivers?.self?.tiles.some(t=>t.sideways===true&&t.tile===pending.discardDecision.output.response.split(' ')[1])){
  try{riichiSpan(pending.decision,pending.before,evidenceFrame);}catch{return {status:'waiting_riichi_acceptance'};}
 }
 if(kind==='LIZHI'&&replacement){
  // The visible river proves the actual action; do not force the old tile
  // or an unsuccessful riichi declaration through its original sequence.
  adapter.call=null;
 }else await adapter.continueCall(frame,{...metadata,actionCompleted:kind==='LIZHI',lastOwnDiscard:pending.discardDecision.output.response.split(' ')[1],ownRiichi:riichi,drawAfterDiscard:verified.nextDraw});
 await session.confirm(pending.decision.output.response);
 const riverTracking=Object.entries(evidenceFrame.rivers??{}).flatMap(([position,r])=>r.tiles.filter(t=>t.tracking).map(t=>({position,tile:t.tile,center:t.center,source:t.tracking.source})));
 return {status:'special_confirmed',frame:frame.id,nextDraw:verified.nextDraw,riverTracking,anchor:kind==='LIZHI'?{decision:pending.decision,before:pending.before}:{decision:pending.discardDecision,before:pending.discardBefore},totalMs:performance.now()-pending.started};
}
