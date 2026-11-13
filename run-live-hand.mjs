import {captureWithDecisionTimer} from './search-budget.mjs';
import {reconnectAdapter} from './hand-continuity.mjs';
import {GAME,remainingHands} from './game-rules.mjs';
import {saveStatus,flushEvidence,appendEvidence} from './background-evidence.mjs';
import {resolveNineTerminals} from './nine-terminals.mjs';
import {OpeningScoreRetry} from './opening-score-retry.mjs';
import {readFile,writeFile,mkdir,open,unlink,rename} from 'node:fs/promises';
import {verifyEngineBuild} from './engine-builds.mjs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {NativeCapture} from './native-capture.mjs';
import {ContinuousCapture} from './continuous-capture.mjs';
import {ClientAdapter} from './client-adapter.mjs';
import {TingfengSession} from './bridge.mjs';
import {LiveCycle} from './live-cycle.mjs';
import {verifyDiscard} from './discard-verification.mjs';
import {roundIdentity} from './round-boundary.mjs';
import {nextOpening,estimatedNextOpening} from './next-opening.mjs';
import {checkpointReplacer} from './checkpoint-json.mjs';
import {cleanupRuntime} from './runtime-cleanup.mjs';
import {acquireProcessLock} from './process-lock.mjs';
import {SettlementCollector,finalizePassiveSettlement} from './passive-settlement.mjs';
import {tableScoreSettlement,snapshotPointContext} from './table-score-settlement.mjs';
import {TerminalLog,actionName} from './terminal-log.mjs';
import {waitHistory} from './wait-details.mjs';
import {snapshotRecovery} from './snapshot-recovery.mjs';
import {acquireStart} from './acquire-start.mjs';
import {clickGameTitle} from './focus-game.mjs';
import {SearchBudget} from './search-budget.mjs';

const ROOT=dirname(fileURLToPath(import.meta.url));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

// Configuration is a visible, manually verified first-turn checkpoint, not
// permission to resume an unknown pending input or invent missed events.
export function validateOpening(config,frame){
 const {seats,hand,draw,rivers,context}=config;
 if(!frame.hand?.complete||!same(frame.hand.tiles.map(t=>t.tile),[...hand,draw]))throw Error('Opening hand changed or incomplete');
 if(hand.length!==13||!same(Object.values(seats).sort(),GAME.seats))throw Error('Invalid opening checkpoint');
 const r=frame.round;
 if(!r?.seat_identity?.verified||!same(r.seat_identity.seats,seats)||r.wind!==config.wind||r.hand_number?.value!==context.hand_index||r.counters?.honba!==context.honba||r.counters?.riichi_sticks!==context.riichi_sticks)throw Error('Opening round changed');
 if(!frame.own_melds?.complete||frame.own_melds.groups.length)throw Error('Opening contains a meld');
 for(const p of GAME.positions){
  if(!frame.rivers?.[p]?.complete||!same(frame.rivers[p].tiles.map(t=>t.tile),rivers[p]))throw Error('Opening river changed');
  const expected=seats[p]<seats.self?1:0;
  if(rivers[p].length!==expected)throw Error('Only an observed first turn can start this runner');
  if(p!=='self'&&(!frame.opponent_melds?.[p]?.complete||frame.opponent_melds[p].groups.length))throw Error('Opening opponent meld');
 }
 if(r.remaining?.value!==(GAME.initialWall-1)-seats.self)throw Error('Opening wall count changed');
}

// The first accepted opening frame may already contain discards preceding
// our first turn. The live diff starts at that frame, so publish its visible
// prefix once before our draw, without reading synthetic opponent DRAWs.
export function openingRiverEvent(frame){
 const seats=frame.round.seat_identity.seats,requests=[];
 for(let seat=0;seat<seats.self;seat++){
  const pos=Object.keys(seats).find(p=>seats[p]===seat),river=frame.rivers[pos];
  if(!river?.complete)continue;
  for(const [i,t] of river.tiles.entries())if(!t.tracking)requests.push({state:`3 ${seat} ${t.sideways?'LIZHI':'PLAY'} ${t.tile}`,validact:null,riverIndex:t.row!=null&&t.column!=null?t.row*6+t.column:i});
 }
 return requests.length?{kind:'visible_public_events',frame:frame.id,source:'visible-opening-rivers',requests}:null;
}
export function validateResume(saved,frame){
 if(!saved?.decision?.output?.response?.startsWith('PLAY ')||!saved.decision.ledger)throw Error('Saved ordinary input required');
 const before=roundIdentity(saved.before),after=roundIdentity(frame);
 if(!before||!after||!same(before,after))throw Error('Interrupted hand identity changed');
 return verifyDiscard(saved.decision,saved.before,frame);
}

export async function runLiveHand(config){
 let continuing=config.runtime?.continuing;
 const handContinuity=config.runtime?.handContinuity;
 const terminal=continuing?.terminal??new TerminalLog();
 const directory=resolve(config.directory);
 await mkdir(directory,{recursive:true});
 const showOpeningRiver=frame=>{
  const event=openingRiverEvent(frame);if(!event)return;
  terminal.event(event);
  appendEvidence(join(directory,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),...event})+'\n');
 };
 const lockPath=join(GAME.runtimeRoot??ROOT,'queue','live-run.lock');await mkdir(dirname(lockPath),{recursive:true});
 const lock=await acquireProcessLock(lockPath,JSON.stringify({pid:process.pid,directory,startedAt:new Date().toISOString()}));
 let capture=config.runtime?.capture,recorder,adapter=config.runtime?.adapter,session,pump,originalInspect,matchEnded=false;
 const settlements=continuing?.settlements??new SettlementCollector();
 const status={pid:process.pid,startedAt:new Date().toISOString(),status:'initializing',actions:0};
 async function save(extra={}){
  Object.assign(status,extra,{updatedAt:new Date().toISOString()});
  saveStatus(join(directory,'status.json'),JSON.stringify(status,null,2));
 }
 try{
  status.engine=await verifyEngineBuild(config.executable);
  capture=config.runtime?.capture??new NativeCapture(config.window);await capture.ready;
  adapter=config.runtime?.adapter??new ClientAdapter({get_window_state:()=>capture.capture()},config.window);await adapter.ready;
  if(continuing)reconnectAdapter(continuing.pump.adapter,adapter);
  adapter.onModalStatus=message=>terminal.line(message);
  adapter.onCallWaitDetected=event=>terminal.callWaitConfirmed(event);

  if(GAME.sanma&&!config.runtime?.adapter)adapter.searchBudget=SearchBudget.forEngine(status.engine);
  adapter.searchBudget??=new SearchBudget();
  const scoreRetry=continuing?.scoreRetry??new OpeningScoreRetry();
  originalInspect=adapter.inspect;
  const inspect=originalInspect.bind(adapter);
  adapter.inspect=async (...args)=>{
   if(scoreRetry.active)args[0]={...(args[0]??{}),readTableScores:true};
   const inspectButtons=async()=>{const frame=await inspect(...args);terminal.observeButtons(frame);return frame;};
   let frame=await inspectButtons();
   frame=await resolveNineTerminals(frame,{inspect:inspectButtons,adapter,signal:config.signal,
    report:message=>terminal.line(message),
    record:event=>appendEvidence(join(directory,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),...event})+'\n','utf8')});
   const corrected=scoreRetry.observe(frame,session?.context??config.context,session?.requests??[]);
   if(corrected){
    config.context=corrected;if(session)session.context=corrected;
    const seats=frame.round.seat_identity.seats,current=[];
    for(const p of GAME.positions)current[seats[p]]=frame.table_scores.scores[p].value;
    adapter.points=null;adapter.initializePoints(current,frame.round.counters.riichi_sticks,seats);
    terminal.scoreRef=terminal.line('牌桌中央点数已纠正（原点数 '+terminal.cited(terminal.scoreRef)+'）：'+GAME.positions.map(p=>`${({self:'自己',right:'下家',opposite:'对家',left:'上家'})[p]} ${current[seats[p]]}`).join(' / '));
   }
   terminal.callWaitPending=adapter.callWaitEvidence.pending;
   terminal.observe(frame,waitHistory(session),{deferDraw:true});
   for(const message of adapter.searchBudget.drain())terminal.budgetNotice(message);
   // Observe all phases, including pending discard, own win and call animations.
   // An intervening non-overlay frame must not erase an already stable result.
   settlements.observe(frame,config.seats);
   // Stable settlement overlay is the result, without a central-score veto.
   const finalScores=settlements.candidate,ctx=session?.context??config.context;
   if(finalScores&&ctx?.scores)
    terminal.settlement(finalScores,ctx,JSON.stringify([config.seats,ctx.hand_index,ctx.honba]));
   return frame;
  };
  await adapter.prepareOutput();
  let lastCentralRecoveryNotice=null;
  adapter.searchBudget.report=message=>terminal.budgetNotice(message);
  recorder=new ContinuousCapture(()=>captureWithDecisionTimer(capture,adapter.searchBudget,adapter.searchBudget.inSearch,adapter.searchBudget.report),join(directory,'captures'));
  recorder.start({durationMs:(config.durationMs??300000)+60000,intervalMs:100,
   onPriorityFrame:state=>adapter.dismissModal(state),
   onCaptureState:async event=>appendEvidence(join(directory,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),...event})+'\n','utf8'),
   onCentralStill:async(state,stall)=>{
   const frame=adapter.latest??pump?.frame;
   if(!frame||(!session&&!roundIdentity(frame))||frame.settlement?.complete||frame.terminal_phase?.name==='match_end')return false;
   if(lastCentralRecoveryNotice!==stall.since){
    terminal.line('检测到Mahjong Soul卡顿，正在尝试恢复');lastCentralRecoveryNotice=stall.since;
   }
   try{
    if(await adapter.clickRecovery(()=>clickGameTitle(config.window))===false)return false;
    await appendEvidence(join(directory,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),kind:'central_pixels_still_title_click',thresholdMs:2000})+'\n','utf8');
   }catch(error){await appendEvidence(join(directory,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),kind:'title_click_unavailable',reason:error.message})+'\n','utf8');}
   return true;
  }});
  adapter.captureSource=recorder;adapter.captureSequence=0;
  const runEnd=performance.now()+(config.durationMs??300000);let handsCompleted=continuing?.handsCompleted??0;
  if(!continuing&&config.autoOpening){
   const start=await acquireStart(()=>adapter.inspect({meld_count:0,phase:'auto',auto_meld_count:true,readTableScores:true}),config,{until:runEnd,signal:config.signal});
   if(start.opening)config={...config,...start.opening,openingFrame:start.frame};
   else{
    try{config.context=snapshotPointContext(start.frame,start.snapshot,config.context);}catch{config.context={...config.context,estimated:true,source:'estimated-midgame-points'};}
    if(config.context?.estimated)start.snapshot.assumptions.push('点数暂用估计值，待可见结算校正');
    config={...config,seats:start.frame.round.seat_identity.seats,openingFrame:start.frame,snapshot:start.snapshot,snapshotStart:false};
   }
  }
  if(!continuing&&config.snapshotStart){
   let frame,snapshot;
   while(performance.now()<runEnd&&!config.signal?.aborted){
    frame=await adapter.inspect({meld_count:config.snapshotMeldCount??0,phase:'auto',auto_meld_count:true,readTableScores:true});
    try{snapshot=snapshotRecovery(frame);break;}catch{}
   }
   if(!snapshot)throw Error('Current snapshot acquisition stopped');
   try{config.context=snapshotPointContext(frame,snapshot,config.context);}catch{config.context={...config.context,estimated:true,source:'estimated-midgame-points'};}
   if(config.context?.estimated)snapshot.assumptions.push('点数暂用估计值，待可见结算校正');
   config={...config,seats:frame.round.seat_identity.seats,openingFrame:frame,snapshot};
  }
  if(!continuing&&config.context)adapter.initializePoints(config.context.scores,config.context.riichi_sticks,config.seats);
  while(true){
  session=continuing?.session??new TingfengSession(config.executable,join(directory,handsCompleted?`session-${handsCompleted+1}`:'session'));
  session.verifiedBudgetEngine=status.engine;
  session.searchBudget=adapter.searchBudget;
  if(!continuing)scoreRetry.begin(config.context);
  const decide=TingfengSession.prototype.decide.bind(session);
  session.decide=async (...args)=>{const decisionFrame=structuredClone(terminal.scoreFrame);if(args[0]?.state?.startsWith('2 '))terminal.publicEvent(args[0]);terminal.beforeButtonDecision(args[0]);let decision;try{decision=await decide(...args);}finally{scoreRetry.decisionFinished();}if(!args[2]?.reuseObserved&&args[0]?.state?.startsWith('3 '))terminal.ledgerEvents([args[0]],decision.input.requests.length-1);terminal.decision(decision,waitHistory(session),args[0],decisionFrame);return decision;};
  const observeVerified=TingfengSession.prototype.observeVerified.bind(session);
  session.observeVerified=(...args)=>{const result=observeVerified(...args);terminal.ledgerEvents(args[0].requests,session.requests.length-args[0].requests.length);return result;};
  const reconcile=TingfengSession.prototype.reconcileVisibleHand.bind(session);
  session.reconcileVisibleHand=(hand,options)=>{const old=[...(session.ledger?.hand??[])],changed=reconcile(hand,options);if(changed)terminal.handCorrection(old,hand);return changed;};
  let before,first,proof;
  if(continuing){
   pump=continuing.pump;pump.adapter=adapter;
   terminal.line('采集已重新接入，沿用本局事件记录');continuing=null;
  }else if(config.openingFrame){
   before=config.openingFrame;
   adapter.searchBudget.beginHand(roundIdentity(before),before.time_reserve);
   for(const message of adapter.searchBudget.drain())terminal.budgetNotice(message);
   terminal.startRound(before);
   if(config.snapshot){session.context=config.context;session.restoreSnapshot(config.snapshot);}
   else session.begin({seat:config.seats.self,round:config.wind,hand:config.hand,indicator:config.indicator,context:config.context});
   pump=new LiveCycle(adapter,session,{before,decision:null,evidence:join(directory,'events.jsonl')});
   if(config.snapshot){
    terminal.takeover(before,session.context,config.snapshot.event);
    const screenshot=await pump.preserveRebuildFrame(structuredClone(before),'从当前画面建立接续历史','initial_snapshot_recovery');
    await pump.record({kind:'initial_snapshot_recovery',frame:before.id,assumptions:config.snapshot.assumptions,screenshot});
    pump.snapshotEvent=config.snapshot.event;pump.publicFrame=before;delete config.snapshot;
   }
   else {terminal.baseline(before,config.hand,session.context);showOpeningRiver(before);pump.opening={hand:config.hand,indicator:config.indicator};}
   delete config.openingFrame;
   await save({status:'running',openingFrame:before.id,executableSha256:status.engine.sha256,automaticInitialOpening:true});
  }else{
  if(config.resume){
   before=config.resume.before;first={decision:config.resume.decision};
   const after=await adapter.inspect({meld_count:before.hand.meld_count,phase:'auto'});
   proof=validateResume(config.resume,after);
   adapter.searchBudget.beginHand(roundIdentity(after),after.time_reserve);
   terminal.startRound(after);
   session.seat=config.seats.self;session.context=first.decision.input.match_context;
   session.pending=first.decision;
   await save({status:'running',recovery:'Verified prior input effect; no resend',openingFrame:before.id,executableSha256:status.engine.sha256});
  }else{
   session.begin({seat:config.seats.self,round:config.wind,hand:config.hand,indicator:config.indicator,context:config.context});
   for(let seat=0;seat<config.seats.self;seat++){
   const p=Object.keys(config.seats).find(p=>config.seats[p]===seat);
   session.observe({state:`3 ${seat} DRAW`,validact:null});
   session.observe({state:`3 ${seat} PLAY ${config.rivers[p][0]}`,validact:null});
   }
   before=await adapter.inspect({meld_count:0,phase:'auto'});validateOpening(config,before);
   adapter.searchBudget.beginHand(roundIdentity(before),before.time_reserve);
   terminal.startRound(before);terminal.baseline(before,config.hand,session.context);showOpeningRiver(before);
   await save({status:'running',openingFrame:before.id,executableSha256:status.engine.sha256});
   first=await adapter.decideAndDiscard(session,{state:`2 ${config.draw}`,validact:'PLAY'},before);
   terminal.line('操作已发送：'+actionName(first.decision.output.response));
   for(const message of adapter.searchBudget.drain())terminal.budgetNotice(message);
   terminal.flushBudgetNotice();
   await save({pending:first.decision.output.response});
  }
  if(proof){
   await session.confirm(first.decision.output.response);
   pump=new LiveCycle(adapter,session,{decision:first.decision,before,evidence:join(directory,'events.jsonl')});
  }else{
   // First discard uses the same retry/recovery path as every later discard.
   const pending=session.pending;session.pending=null;
   pump=new LiveCycle(adapter,session,{decision:first.decision,before,evidence:join(directory,'events.jsonl')});
   session.pending=pending;
   pump.pending={decision:first.decision,before,started:performance.now()};
  }
  }
  handContinuity?.retain({session,pump,terminal,settlements,scoreRetry,handsCompleted,directory,wind:config.wind,seats:config.seats,round:roundIdentity(pump.anchor.before)});
  const record=LiveCycle.prototype.record.bind(pump);
  pump.bindButtons=(evidence)=>terminal.bindButtons(evidence);
  pump.onVisibleFrame=async frame=>{
   terminal.observe(frame,waitHistory(session));
  };
  pump.record=async event=>{await record(event);terminal.event(event);
 await save({actions:pump.actions,lastEvent:event.kind,lastAction:event.action,pending:session.pending?.output.response??null});};
  await save({pending:null,initialProof:proof});
  const result=await pump.run({milliseconds:Math.max(0,runEnd-performance.now()),maxActions:config.maxActions??60,signal:config.signal});
  if(result.status==='round_boundary'||result.status==='hand_ended'){
   handContinuity?.clear();
   handsCompleted++;
   await save({status:'recovering_current_table',lastResult:result,handsCompleted});
   let opening;
   // A terminal match or an unreadable/missed opening never authorizes input.
   // The time bound keeps the CLI finite without aborting a sent transaction.
   const nextDeadline=Math.min(runEnd,performance.now()+30000);
   let tableReadAttempted=false,tableProof=null;
   const openingWaitReasons=new Map();
   const scoreWaitUntil=performance.now()+1500;
   while(performance.now()<nextDeadline&&!config.signal?.aborted){
    let next=await adapter.inspect({meld_count:0,phase:'auto',observeSettlement:true,auto_meld_count:true});
    const identity=roundIdentity(next);
    if(!tableReadAttempted&&!settlements.candidate&&!result.proof?.verified&&performance.now()>=scoreWaitUntil&&identity&&
       (identity.wind!==(config.wind??0)||identity.hand!==config.context.hand_index||identity.honba!==config.context.honba)){
     tableReadAttempted=true;
     try{
      next=await adapter.inspect({meld_count:0,phase:'auto',observeSettlement:true,auto_meld_count:true,readTableScores:true});
      const labels={self:'自己',right:'下家',opposite:'对家',left:'上家'};
      terminal.line('结算漏读，牌桌中央点数：'+GAME.positions.map(p=>`${labels[p]} ${next.table_scores?.scores?.[p]?.value??'未读出'}`).join(' / '));
      tableProof=tableScoreSettlement(config,{frame:next,firstId:next.id},next);
     }catch(error){terminal.line(`中央点数补读未能采用：${error.message}`);}
    }
    if(next.terminal_phase?.name==='match_end'){
     const ended={status:'match_ended',handsCompleted,frame:next.id};await save({status:'finished',result:ended});matchEnded=true;return ended;
    }
    try{
     // Central scores are fallback only; a stable overlay takes precedence.
     let proof;
     if(settlements.candidate)proof=finalizePassiveSettlement(config,settlements.candidate,next);
     else if(result.proof?.verified)proof=result.proof;
     else if(tableProof)proof=tableProof;
     else {
      if(performance.now()<scoreWaitUntil)continue;
      proof=result.proof?.verified?result.proof:finalizePassiveSettlement(config,settlements.candidate??result.proof,next);
     }
     opening=nextOpening(config,proof,next,{allowSnapshot:true});
     terminal.settlement(proof,session.context??config.context,JSON.stringify([config.seats,config.context.hand_index,config.context.honba]));
     await save({verifiedSettlement:proof});break;
    }catch(openingError){
     try{opening=estimatedNextOpening({...config,context:session.context??config.context},next);
      terminal.line('结算点数漏读：暂用估计点数继续下一局，等待后续结算校正');
      await save({estimatedSettlement:opening.context});break;
     }catch(fallbackError){
      // A transient deal or an opponent's turn is normal waiting. If a
      // current own action remains blocked, expose the actual failed check
      // instead of swallowing it until the whole acquisition window ends.
      const active=next.hand?.phase==='discard'||next.controls?.PASS||next.selection?.verified||next.call_choices?.verified;
      if(!active){for(const retry of openingWaitReasons.values())if(!retry.reported)retry.frames=0;}
      else{
       const reason=fallbackError.message,retry=openingWaitReasons.get(reason)??{frames:0,lastFrame:null,reported:false};
       if(retry.lastFrame!==next.id){retry.frames++;retry.lastFrame=next.id;}
       openingWaitReasons.set(reason,retry);
       if(retry.frames>=2&&!retry.reported){
        retry.reported=true;
        terminal.line(`未能接续新一局：${reason}`);
        await pump.record({kind:'next_opening_blocked',frame:next.id,reason,verifiedOpeningReason:openingError.message});
       }
      }
     }
    }
   }
   if(opening){
    await writeFile(join(directory,`opening-${handsCompleted+1}.json`),JSON.stringify(opening,null,2),'utf8');
    config={...config,...opening};delete config.resume;
    settlements.reset();
    adapter.points=null;adapter.initializePoints(opening.context.scores,opening.context.riichi_sticks,opening.seats);
    adapter.call=null;adapter.publicFrameId=null;
    await save({status:'running',automaticOpening:opening.context.source,pending:null});
    continue;
   }
  }
  await save({status:result.status?.startsWith('unresolved')?'unresolved':'finished',result,actions:pump.actions});
  matchEnded=result.status==='match_ended';
  return result;
  }
 }catch(error){terminal.line(`运行中断：${error.message}`);await save({status:'failed',error:error.message,pending:session?.pending?.output?.response??null});throw error;}
 finally{
  const handBack=matchEnded&&config.runtime?.reuseAfterMatch===true&&!config.signal?.aborted;
  try{await cleanupRuntime([
   ()=>{if(matchEnded||!handContinuity?.state||config.signal?.aborted)session?.pending?.callSearch?.cancel();},
   ()=>writeFile(join(directory,'checkpoint.json'),JSON.stringify({session,pending:pump?.pending,special:pump?.special,win:pump?.win,points:adapter?.points,lastFrame:adapter?.latest},checkpointReplacer,2),'utf8'),
   ()=>recorder?.stop(),()=>{if(!handBack)return adapter?.close();},()=>{if(!handBack)return capture?.close();},
   ()=>flushEvidence(),()=>lock.close(),()=>unlink(lockPath)
  ]);}catch(error){
   if(handBack)await cleanupRuntime([()=>adapter?.close(),()=>capture?.close()]).catch(()=>{});
   throw error;
  }
  if(handBack){
   // The per-hand capture pump is stopped; the resident now owns these same
   // workers and takes fresh frames directly for final confirmation.
   adapter.inspect=originalInspect;
   adapter.captureSource=null;adapter.captureSequence=0;
   adapter.onCallWaitDetected=null;
   adapter.resetMatchState?.();
   adapter.searchBudget=SearchBudget.forEngine(status.engine);
   config.runtime.capture=capture;config.runtime.adapter=adapter;
   config.runtime.postMatchReady=true;
  }
 }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const config=JSON.parse(await readFile(process.argv[2],'utf8'));
 runLiveHand(config).then(result=>console.log(`听风执牌：本次运行结束（${result.status}），详细结果已保存到本次记录目录。`),error=>{console.error(error.message);process.exitCode=1;});
}
