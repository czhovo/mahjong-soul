import {HandContinuity} from './hand-continuity.mjs';
import {appendEvidence} from './background-evidence.mjs';
import {GAME,remainingHands} from './game-rules.mjs';
import {mkdir,writeFile,open,unlink} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {NativeCapture} from './native-capture.mjs';
import {ClientAdapter} from './client-adapter.mjs';
import {openingPrefix} from './opening-prefix.mjs';
import {canRecoverOpening,OpeningEntryProgress} from './opening-entry.mjs';
import {roundIdentity} from './round-boundary.mjs';
import {nextOpening} from './next-opening.mjs';
import {runLiveHand} from './run-live-hand.mjs';
import {SearchBudget} from './search-budget.mjs';
import {SHORT_EXECUTABLE,DEFAULT_EXECUTABLE,verifyEngineBuild} from './engine-builds.mjs';
import {TerminalLog} from './terminal-log.mjs';
import {WindowDiscovery} from './window-discovery.mjs';
import {snapshotRecovery} from './snapshot-recovery.mjs';
import {acquireProcessLock} from './process-lock.mjs';
import {MatchContinuation} from './match-continuation.mjs';
import {StartFlow,startActionName} from './start-flow.mjs';
import {restartGame} from './restart-game.mjs';

const ROOT=dirname(fileURLToPath(import.meta.url));
export function pollDelay(elapsed,pollMs=250){return Math.max(0,pollMs-elapsed);}
const positions=GAME.positions;
const quietProgressMessages=new Set([
 '雀魂已在前台，正在识别局面','已进入对局，正在识别当前局面',
 '正在确认当前局面','已接入本局，等待首个可操作时点',
 '局面尚未识别完整，继续识别当前局','局面暂未识别清楚，继续识别当前局',
 '正在恢复当前局面','正在估计点数并恢复当前局面','正在读取结算',
 '整场对局结束，准备处理结算页面',
]);
export function openingWaitMessage(error){
 if(error.code==='OPENING_PASSED'||error.code==='ROUND_BLOCKED')return '正在恢复当前局面';
 if(error.code==='SCORES_MISSING')return '正在估计点数并恢复当前局面';
 return '局面尚未识别完整，继续识别当前局';
}
export class ResidentStatusLog{
 constructor(log){this.log=log;this.message='';this.timer=null;this.group=null;this.seen=new Set();}
 set(message,waiting=true,group=null){
  if(quietProgressMessages.has(message))return;
  if(group!==this.group||group===null)this.seen.clear();
  this.group=group;
  const duplicate=message===this.message||(group!==null&&this.seen.has(message));
  this.close();this.message=message;
  if(duplicate)return;
  this.seen.add(message);this.log.line(message);
 }
 close(){clearInterval(this.timer);this.timer=null;}
}
export function selectGame(windows){
 const active=windows.filter(w=>w.foreground&&!w.minimized);
 return active.length===1?active[0]:null;
}
export function initialContext(r,scores){
 const advance=r.hand-1; // Four rounds per wind preserve the same modulo-four priority.
 return {schema:1,scores,riichi_sticks:0,honba:r.honba,hand_index:r.hand,
  remaining_scheduled_hands:remainingHands(r.wind,r.hand),is_last_scheduled_hand:remainingHands(r.wind,r.hand)===1,
  tie_priority:GAME.seats.map(s=>(s-advance+GAME.players)%GAME.players),source:'resident-observed-opening'};
}
export class WaitingState{
 constructor(initialScores=[...GAME.initialScores]){if(initialScores.length!==GAME.players||initialScores.some(v=>!Number.isInteger(v)||v<0))throw Error('初始点数必须是'+(GAME.sanma?'三个':'四个')+'非负整数');this.initialScores=initialScores;this.round=null;this.candidate=null;this.settled=null;this.blockedRound=null;}
 observe(frame){
  if(frame.terminal_phase?.name==='match_end'){this.postMatch=true;this.round=null;this.candidate=null;this.settled=null;return 'match_end';}
  const r=roundIdentity(frame);if(r)this.round=r;
  if(this.postMatch&&!r)return 'match_end';
  if(r)this.postMatch=false;
  const s=frame.settlement;
  if(!s?.complete){this.candidate=null;return r?'in_game':'unknown';}
  const values=positions.map(p=>s.scores?.[p]?.value);
  if(!this.round||values.some(v=>!Number.isInteger(v)))return 'unknown';
  const signature=JSON.stringify(values);
  if(this.candidate?.signature===signature&&this.candidate.id!==frame.id&&Number.isFinite(frame.capturedAt)&&frame.capturedAt-this.candidate.capturedAt>=1000){
   this.settled={round:this.round,values,ids:[this.candidate.id,frame.id]};
  }
  if(this.candidate?.signature!==signature){this.settled=null;this.candidate={signature,id:frame.id,capturedAt:frame.capturedAt};}return 'settlement';
 }
 opening(frame){
  const prefix=openingPrefix(frame,{allowPending:true}),r=prefix.round;
  const sticks=frame.round.counters.riichi_sticks;
  if(this.settled){
   const old=this.settled;
   const scores=[];positions.forEach((p,i)=>scores[old.round.seats[p]]=old.values[i]);
   const previous={wind:old.round.wind,context:initialContext(old.round,scores)};
   const proof={verified:true,source:'visible-settlement',scores,seats:old.round.seats,riichiSticks:sticks,
    observationId:old.ids[1],observationIds:old.ids,progressionEvidence:'settlement-and-next-opening',nextObservationId:frame.id};
   const start=nextOpening(previous,proof,frame);
   // The live runner re-captures the opening; no transient pixels are retained as an input anchor.
   delete start.openingFrame;return {...start,autoOpening:true};
  }
  if(r.wind!==0||r.hand!==1||r.honba!==0||sticks!==0)throw Object.assign(Error('等待完整结算和下一局开局'),{code:'SCORES_MISSING'});
  return {wind:0,context:initialContext(r,[...this.initialScores]),autoOpening:true};
 }
}

export async function runResident(options={}){
 const engine=await verifyEngineBuild(options.shortOnly?SHORT_EXECUTABLE:(options.executable??DEFAULT_EXECUTABLE));
 const autoRematch=options.autoRematch??true;
 const log=new TerminalLog(),controller=new AbortController(),signal=options.signal??controller.signal;
 const engineLabel=(GAME.sanma?'听元':'听风')+' '+engine.version.replace(/-(?:5p5|3p5|2p2|3p3|1p7)$/,'');
 log.line([engineLabel,'听风执牌v7',...(options.startupArgs??[])].join(' '));
 const stop=()=>controller.abort();if(!options.signal){process.on('SIGINT',stop);process.on('SIGTERM',stop);}
 const services=options.services??{};
 let discovery;
 const discover=services.discover??(()=>{if(!discovery||discovery.error){discovery?.close();discovery=new WindowDiscovery(options.python);}return discovery.discover();});
 const makeCapture=services.makeCapture??((w,p)=>new NativeCapture(w,{transientPath:p,saveAllScreenshots:options.saveAllScreenshots}));
 const adapterFactory=services.makeAdapter??((c,w)=>new ClientAdapter({get_window_state:()=>c.capture()},w));
 const makeAdapter=(c,w)=>{const adapter=adapterFactory(c,w);if(options.shortOnly)adapter.searchBudget=new SearchBudget(true);else if(GAME.sanma)adapter.searchBudget=SearchBudget.forEngine(engine);adapter.onModalStatus=message=>log.line(message);return adapter;};
 const play=services.play??runLiveHand;
 const continuation=services.continuation??new MatchContinuation({allowRematch:autoRematch!==false,brief:options.briefPostMatch===true,onRecovery:(action,seconds=10)=>status(`终局操作${seconds}秒未推进，已重试上一个动作：${{CONFIRM:'确认',REMATCH:'再来一场',REMATCH_CONFIRM:'确认再来一场',EXIT:'确认退出'}[action]}`,{},false)});
 const startFlow=services.startFlow??new StartFlow({bronze:options.briefPostMatch===true,gold:options.goldRoom===true,jade:options.jadeRoom===true,onRecovery:(action,seconds=10)=>status(`开局操作${seconds}秒未推进，已重试上一个动作：${startActionName[action]}`,{},false)});
 const base=resolve(options.directory??join(GAME.runtimeRoot??ROOT,'test-evidence/resident'));
 await mkdir(base,{recursive:true});await mkdir(join(GAME.runtimeRoot??ROOT,'queue'),{recursive:true});
 const lockPath=services.lockPath??join(GAME.runtimeRoot??ROOT,'queue/resident.lock'),lock=await acquireProcessLock(lockPath,String(process.pid));
 let capture,adapter,bound,stateWindowId,state=new WaitingState(options.initialScores),runNumber=0,foregroundId=null,matchCompleted=false,postMatchFlow=false,startupFailure=null;
 const statusLog=new ResidentStatusLog(log);
 let lastStatusEvidence=null;
 const status=async(message,extra={},waiting=true)=>{
  const group=message==='正在通过 AutoHotkey 恢复并激活雀魂窗口'||message.startsWith('等待恢复：')?'window-recovery':null;
  statusLog.set(message,waiting,group);
  const evidenceKey=JSON.stringify([message,extra.reason,extra.code]);
  if(evidenceKey!==lastStatusEvidence){
   lastStatusEvidence=evidenceKey;
   appendEvidence(join(base,'resident-events.jsonl'),JSON.stringify({at:new Date().toISOString(),pid:process.pid,message,...extra})+'\n');
  }
  await writeFile(join(base,'status.json'),JSON.stringify({pid:process.pid,updatedAt:new Date().toISOString(),engine,message,...extra},null,2),'utf8');
 };
 const handContinuity=new HandContinuity();
 const entryProgress=new OpeningEntryProgress();
 const close=async()=>{try{await adapter?.close();}finally{try{await capture?.close();}finally{adapter=null;capture=null;bound=null;}}};
 try{
  await status('等待进入对局');
  while(!signal.aborted){
   const cycleStart=performance.now();
   try{
    const windows=await discover(),window=selectGame(windows);
    if(!window){
     foregroundId=null;
     if(windows.length===1){
      await status('正在通过 AutoHotkey 恢复并激活雀魂窗口');
      const focus=services.focus??(await import('./focus-game.mjs')).focusGame;
      await focus(windows[0]);
     }else await status(windows.length?'发现多个雀魂窗口，无法唯一确定目标':'等待雀魂窗口');
    }
    else{
     if(foregroundId!==window.id){foregroundId=window.id;await status('雀魂已在前台，正在识别局面');}
     if(bound?.id!==window.id){await close();if(stateWindowId!==window.id){state=new WaitingState(options.initialScores);stateWindowId=window.id;}capture=makeCapture(window,join(base,'waiting-frame.bmp'));await capture.ready;
      adapter=makeAdapter(capture,window);await adapter.ready;bound=window;}
     const probe=await adapter.inspect({phase:postMatchFlow?'post_match':'probe',persistEvidence:false});
     const phase=postMatchFlow?'match_end':state.observe(probe);
     if(continuation.previousAction?.action==='REMATCH_CONFIRM'&&phase!=='in_game'&&phase!=='match_end'){
      await continuation.step(probe,adapter);
      await delay(250,null,{signal}).catch(()=>{});continue;
     }
     if(phase!=='match_end')continuation.finish?.();
     if(phase==='match_end'){
      entryProgress.reset();
      handContinuity.clear();startFlow.finish();
      postMatchFlow=true;
      if(autoRematch===false&&!options.finishResults){matchCompleted=true;break;}
      const action=await continuation.step(probe,adapter);
      if(action==='FINISHED'){matchCompleted=true;break;}
      if(action==='REMATCH_CONFIRM'){postMatchFlow=false;state=new WaitingState(options.initialScores);}
      if(action)await status(`终局操作已发送：${{CONFIRM:'确认',REMATCH:'再来一局',REMATCH_CONFIRM:'确认',EXIT:'确认退出'}[action]}`,{},false);
     }
     else if(phase==='in_game'){
      startFlow.finish();
      continuation.beginGame?.();
      if(!state.reportedInGame){state.reportedInGame=true;await status('已进入对局，正在识别当前局面');}
      const frame=await adapter.inspect({meld_count:0,phase:'auto',auto_meld_count:true,persistEvidence:false});
      const continuing=handContinuity.get(frame);
      let opening;
      if(continuing)opening={seats:continuing.seats,wind:continuing.wind,context:continuing.session.context};
      else if(handContinuity.state){await delay(pollDelay(performance.now()-cycleStart,options.pollMs),null,{signal}).catch(()=>{});continue;}
      else try{opening=state.opening(frame);}catch(error){
       if(error instanceof TypeError||error instanceof ReferenceError)throw error;
       let reason=error.message;
       if(canRecoverOpening(frame,error))try{
        const snapshot=snapshotRecovery(frame),r=roundIdentity(frame);
        const scores=[...state.initialScores],sticks=frame.round.counters.riichi_sticks;
        scores[0]-=sticks*1000;
        opening={wind:r.wind,context:{...initialContext(r,scores),riichi_sticks:sticks,source:'estimated-midgame-points',estimated:true},autoOpening:true,snapshotStart:false,snapshotMeldCount:frame.own_melds.groups.length};
        snapshot.assumptions.push('起始点数未取得时暂用默认点数，供托暂从东家扣除');
        await status('正在确认当前局面',{assumptions:snapshot.assumptions});
       }catch(recoveryError){
        if(recoveryError instanceof TypeError||recoveryError instanceof ReferenceError)throw recoveryError;
        reason+='；当前局面接入失败：'+recoveryError.message;
       }
       if(!opening){
        const blocked=entryProgress.observe(frame,reason);
        await status(blocked?'未接入对局：'+reason:'局面尚未识别完整，继续识别当前局',{reason,code:error.code??'INCOMPLETE_OBSERVATION',
         entryBlocked:blocked,
         observationId:frame.id,capturedAt:frame.capturedAt,recognition:{round:frame.round,hand:frame.hand,dora:frame.dora,
          rivers:frame.rivers,own_melds:frame.own_melds,opponent_melds:frame.opponent_melds,kita:frame.kita,time_reserve:frame.time_reserve,controls:frame.controls}});
       }
      }
      if(opening){
       entryProgress.reset();
       const round=roundIdentity(frame),directory=continuing?.directory??join(base,`${new Date().toISOString().replace(/[:.]/g,'-')}-${++runNumber}`);
       const config={...opening,window,directory,executable:engine.executable,
        durationMs:options.durationMs??24*60*60*1000,maxActions:1000};
       await mkdir(directory,{recursive:true});await writeFile(join(directory,'config.json'),JSON.stringify(config,null,2),'utf8');
       await status('已接入本局，等待首个可操作时点',{directory},false);
       // Transfer the already-ready workers instead of restarting recognition at the first turn.
       capture.transientPath=null;
       const runtime={capture,adapter,continuing,handContinuity,reuseAfterMatch:true};capture=null;adapter=null;bound=null;
       runtime.adapter.beginMatchArchive=!continuing;
       let ended=false,rediscover=false;
       try{const result=await play({...config,signal,runtime});ended=result.status==='match_ended';await status(ended?(autoRematch===false?'整场对局结束':'整场对局结束，准备处理结算页面'):'正在恢复当前局面',{directory,result},!ended);}
       catch(error){
        rediscover=/rediscovery required|game restart required/.test(error.message);
        if(/game restart required/.test(error.message)&&!signal.aborted){
         await status('游戏画面连续60秒不变，正在重启雀魂',{directory});
         const restarted=await (services.restartGame??restartGame)(window);
         await status('雀魂已重启，重新搜索游戏窗口',{directory,restarted});
         foregroundId=null;stateWindowId=null;
        }else await status(`正在恢复当前局面：${error.message}`,{directory});
       }
       if(ended)handContinuity.clear();
       if(runtime.postMatchReady){
        capture=runtime.capture;adapter=runtime.adapter;bound=window;
        adapter.onModalStatus=message=>log.line(message);

       }
       if(ended&&autoRematch===false&&!options.finishResults){matchCompleted=true;break;}
       // Rebind without forgetting the rejected round; do not repeatedly submit its initial action.
       state=new WaitingState(options.initialScores);
       state.postMatch=ended;
       postMatchFlow=ended;
       if(signal.aborted)break;
       if(rediscover){await delay(1000,null,{signal}).catch(()=>{});continue;}
       if(!capture){
        capture=makeCapture(window,join(base,'waiting-frame.bmp'));await capture.ready;
        adapter=makeAdapter(capture,window);await adapter.ready;bound=window;
       }

      }
     }else{
      entryProgress.reset();
      const action=options.singleMatch?null:await startFlow.step(probe,adapter);
      if(action)await status(`开局操作已发送：${startActionName[action]} (${startFlow.index}/${startFlow.actions.length})`,{},false);
      else if(options.singleMatch||startFlow.finished||startFlow.index===startFlow.actions.length)
       await status(phase==='settlement'?'正在读取结算':state.round?'局面暂未识别清楚，继续识别当前局':'等待进入对局');
     }
    }
   }catch(error){if(error.code==='NO_PROGRESS_LIMIT')throw error;await status(`等待恢复：${error.message}`);await close();}
   if(!signal.aborted)await delay(pollDelay(performance.now()-cycleStart,options.pollMs),null,{signal}).catch(e=>{if(e.name!=='AbortError')throw e;});
  }
 }catch(error){startupFailure=error;throw error;}finally{
  handContinuity.clear();statusLog.close();
  discovery?.close();
  let cleanupError;
  try{await close();}catch(error){cleanupError=error;}
  try{await lock.close();}finally{await unlink(lockPath);}
  await status(startupFailure?startupFailure.message:(matchCompleted?'整场对局已结束，':'')+'听风执牌已停止',{status:startupFailure?'startup_failed':matchCompleted?'match_ended':'stopped',...(cleanupError?{cleanupError:cleanupError.message}:{})},false);
  if(startupFailure)startupFailure.reported=true;
  if(!options.signal){process.off('SIGINT',stop);process.off('SIGTERM',stop);}
  if(cleanupError&&!startupFailure)throw cleanupError;
 }
}
