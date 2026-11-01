import {countNoProgress} from './no-progress-limit.mjs';
import {LossStreak,LossCooldown} from './loss-cooldown.mjs';
import {reportSavedScreenshot} from './screenshot-log.mjs';
import {reportMatchResult} from './match-result-log.mjs';
import {readFile,mkdir,writeFile,open,unlink} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {NativeCapture} from './native-capture.mjs';
import {ClientAdapter} from './client-adapter.mjs';
import {openingPrefix} from './opening-prefix.mjs';
import {roundIdentity} from './round-boundary.mjs';
import {nextOpening} from './next-opening.mjs';
import {runLiveHand} from './run-live-hand.mjs';
import {DEFAULT_EXECUTABLE,verifyEngineBuild} from './engine-builds.mjs';
import {StartupChecks,checkRecognition,checkDecision,checkOperation} from './startup-checks.mjs';
import {TerminalLog} from './terminal-log.mjs';
import {WindowDiscovery} from './window-discovery.mjs';
import {snapshotRecovery} from './snapshot-recovery.mjs';
import {acquireProcessLock} from './process-lock.mjs';
import {MatchContinuation} from './match-continuation.mjs';
import {StartFlow,startActionName} from './start-flow.mjs';
import {restartGame} from './restart-game.mjs';

const ROOT=dirname(fileURLToPath(import.meta.url));
export function pollDelay(elapsed,pollMs=250){return Math.max(0,pollMs-elapsed);}
const positions=['self','right','opposite','left'];
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
  remaining_scheduled_hands:r.wind===0?5-r.hand:1,is_last_scheduled_hand:r.wind>0||r.hand===4,
  tie_priority:[0,1,2,3].map(s=>(s-advance+4)%4),source:'resident-observed-opening'};
}
export class WaitingState{
 constructor(initialScores=[25000,25000,25000,25000]){if(initialScores.length!==4||initialScores.some(v=>!Number.isInteger(v)||v<0))throw Error('初始点数必须是四个非负整数');this.initialScores=initialScores;this.round=null;this.candidate=null;this.settled=null;this.blockedRound=null;}
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
 const engine=await verifyEngineBuild(options.executable??DEFAULT_EXECUTABLE);
 const autoRematch=options.autoRematch??true;
 const log=new TerminalLog(),controller=new AbortController(),signal=options.signal??controller.signal;
 // 听风执牌 v4。
 log.line([`听风 ${engine.version.replace(/-(?:3p3|1p7)$/, '')} 听风执牌v4`,...(options.startupArgs??[])].join(' '));
 const stop=()=>controller.abort();if(!options.signal){process.on('SIGINT',stop);process.on('SIGTERM',stop);}
 const services=options.services??{};
 let discovery;
 const discover=services.discover??(()=>{if(!discovery||discovery.error){discovery?.close();discovery=new WindowDiscovery(options.python);}return discovery.discover();});
 const makeCapture=services.makeCapture??((w,p)=>new NativeCapture(w,{python:options.python,transientPath:p,saveAllScreenshots:options.saveAllScreenshots}));
 const adapterFactory=services.makeAdapter??((c,w)=>new ClientAdapter({get_window_state:()=>c.capture()},w,{python:options.python,pythonPackages:options.pythonPackages}));
 const makeAdapter=(c,w)=>{const adapter=adapterFactory(c,w);adapter.onModalStatus=message=>log.line(message);adapter.onSavedScreenshot=message=>log.line(message);return adapter;};
 const play=services.play??runLiveHand;
 let emoteState={done:false};
 const losses=new LossStreak(),cooldown=new LossCooldown();let cooldownRequested=false,exitSentAt=null;const exitProgress={};
 const continuation=services.continuation??new MatchContinuation({onResult:result=>{cooldownRequested=losses.observe(result);return cooldownRequested;},brief:options.briefPostMatch===true,onRecovery:action=>status(`终局操作10秒未推进，已重试上一个动作：${{CONFIRM:'确认',REMATCH:'再来一场',REMATCH_CONFIRM:'确认再来一场',EXIT:'确认退出'}[action]}`,{},false)});
 const startFlow=services.startFlow??new StartFlow({bronze:options.briefPostMatch===true,gold:options.goldRoom===true,onRecovery:action=>status(`开局操作10秒未推进，已重试上一个动作：${startActionName[action]}`,{},false)});
 const base=resolve(options.directory??join(ROOT,'test-evidence/resident'));
 await mkdir(base,{recursive:true});await mkdir(join(ROOT,'queue'),{recursive:true});
 const lockPath=services.lockPath??join(ROOT,'queue/resident.lock'),lock=await acquireProcessLock(lockPath,String(process.pid));
 let capture,adapter,bound,stateWindowId,state=new WaitingState(options.initialScores),runNumber=0,foregroundId=null,matchCompleted=false,postMatchFlow=false,startupFailure=null,operationChecked=false;
 const startup=new StartupChecks(base,engine);
 const statusLog=new ResidentStatusLog(log);
 const status=async(message,extra={},waiting=true)=>{
  const group=message==='正在通过 AutoHotkey 恢复并激活雀魂窗口'||message.startsWith('等待恢复：')?'window-recovery':null;
  statusLog.set(message,waiting,group);
  await writeFile(join(base,'status.json'),JSON.stringify({pid:process.pid,updatedAt:new Date().toISOString(),engine,message,...extra},null,2),'utf8');
 };
 let retainedMatchArchive=null;
 const close=async()=>{if(adapter?.lastMatchArchive)retainedMatchArchive=adapter.lastMatchArchive;try{await adapter?.close();}finally{try{await capture?.close();}finally{adapter=null;capture=null;bound=null;}}};
 try{
  await status('recognize v4: Checking',{},false);
  await startup.run('recognition',()=> (services.checkRecognition??checkRecognition)({python:options.python,pythonPackages:options.pythonPackages}));
  await status(`recognize v4: Ready ${(startup.report.checks.recognition.elapsedMs/1000).toFixed(3)}秒`,{},false);
  for(const [version,searchSeconds] of [[engine.version,3.3],[engine.reducedVersion,1.7]]){
   await status(`${version}: Checking`,{},false);
   await startup.run(version,()=> (services.checkDecision??checkDecision)({engine,directory:base,signal,searchSeconds}));
   await status(`${version}: Ready ${(startup.report.checks[version].elapsedMs/1000).toFixed(3)}秒`,{},false);
  }
  await status('等待雀魂窗口');
  while(!signal.aborted){
   if(cooldown.until!==null){
    const remaining=cooldown.remaining();
    if(remaining>0){await delay(Math.min(1000,remaining),null,{signal}).catch(e=>{if(e.name!=='AbortError')throw e;});continue;}
    cooldown.finish();losses.reset();cooldownRequested=false;exitSentAt=null;
    postMatchFlow=false;state=new WaitingState(options.initialScores);emoteState={done:false};
    continuation.beginGame();startFlow.reset();
    await status('等待10分钟结束，继续开局',{},false);
   }
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
      adapter=makeAdapter(capture,window);adapter.restoreMatchArchive=retainedMatchArchive;await adapter.ready;bound=window;}
     if(!operationChecked){
      await status('ahk execute: Checking',{},false);
      await startup.run('operation',()=> (services.checkOperation??checkOperation)({adapter,window}));
      operationChecked=true;
      await status(`ahk execute: Ready ${(startup.report.checks.operation.elapsedMs/1000).toFixed(3)}秒`,{},false);
      await status('等待进入对局');
     }
     const probe=await adapter.inspect({phase:postMatchFlow&&exitSentAt===null?'post_match':'probe',persistEvidence:false});
     let matchResultText;reportMatchResult(probe,text=>{matchResultText=text;});
     if(matchResultText)await status(matchResultText,{},false);
     let screenshotText;reportSavedScreenshot(probe.result_page?.screenshot,text=>{screenshotText=text;});
     if(screenshotText)await status(screenshotText,{},false);
     for(const path of probe.result_page?.additional_screenshots??[]){
      let text;reportSavedScreenshot(path,value=>{text=value;});
      if(text)await status(text,{},false);
     }
     if(cooldownRequested&&exitSentAt!==null){
      if(probe.start_page?.page==='lobby'){
       exitProgress.noProgressCount=0;cooldown.start();
       await status('连续两场终局 PT 减少，已返回大厅，等待10分钟后继续开局',{status:'cooldown',resumeAt:new Date(Date.now()+600000).toISOString()},false);
       continue;
      }
      if(performance.now()-exitSentAt>=10000&&probe.terminal_phase?.controls?.EXIT){
       countNoProgress(exitProgress);await adapter.sendClick(probe,probe.terminal_phase.controls.EXIT.center);exitSentAt=performance.now();
       await status('终局操作10秒未推进，已重试确认退出',{},false);
      }
      await delay(250,null,{signal}).catch(()=>{});continue;
     }
     const phase=postMatchFlow?'match_end':state.observe(probe);
     if(phase!=='match_end')continuation.finish?.();
     if(phase==='match_end'){
      startFlow.finish();
      postMatchFlow=true;
      if(autoRematch===false){matchCompleted=true;break;}
      const action=await continuation.step(probe,adapter);
      let finalScreenshotText;reportSavedScreenshot(probe.result_page?.screenshot,text=>{finalScreenshotText=text;});
      if(finalScreenshotText)await status(finalScreenshotText,{},false);
      if(action==='EXIT')exitSentAt=performance.now();
      if(action==='REMATCH_CONFIRM'){continuation.finish?.();postMatchFlow=false;state=new WaitingState(options.initialScores);emoteState={done:false};}
      if(action)await status(`终局操作已发送：${{CONFIRM:'确认',REMATCH:'再来一局',REMATCH_CONFIRM:'确认',EXIT:'确认退出'}[action]}`,{},false);
     }
     else if(phase==='in_game'){
      startFlow.finish();
      continuation.beginGame?.();losses.beginGame();
      if(!state.reportedInGame){state.reportedInGame=true;await status('已进入对局，正在识别当前局面');}
      const frame=await adapter.inspect({meld_count:0,phase:'auto',auto_meld_count:true,persistEvidence:false});
      let opening;
      try{opening=state.opening(frame);}catch(error){
       try{
        const snapshot=snapshotRecovery(frame),r=roundIdentity(frame);
        const scores=[...state.initialScores],sticks=frame.round.counters.riichi_sticks;
        scores[0]-=sticks*1000;
        opening={wind:r.wind,context:{...initialContext(r,scores),riichi_sticks:sticks,source:'estimated-midgame-points',estimated:true},autoOpening:true,snapshotStart:false,snapshotMeldCount:frame.own_melds.groups.length};
        snapshot.assumptions.push('起始点数未取得时暂用默认点数，供托暂从东家扣除');
        await status('正在确认当前局面',{assumptions:snapshot.assumptions});
       }catch{await status(openingWaitMessage(error),{reason:error.message,code:error.code??'INCOMPLETE_OBSERVATION'});}
      }
      if(opening){
       const round=roundIdentity(frame),directory=join(base,`${new Date().toISOString().replace(/[:.]/g,'-')}-${++runNumber}`);
       const config={...opening,window,directory,emoteState,executable:engine.executable,
        durationMs:options.durationMs??24*60*60*1000,maxActions:1000};
       await mkdir(directory,{recursive:true});await writeFile(join(directory,'config.json'),JSON.stringify(config,null,2),'utf8');
       await status('已接入本局，等待首个可操作时点',{directory},false);
       // Transfer the already-ready workers instead of restarting recognition at the first turn.
       capture.transientPath=null;
       const runtime={capture,adapter};capture=null;adapter=null;bound=null;
       runtime.adapter.beginMatchArchive=true;runtime.adapter.restoreMatchArchive=null;runtime.adapter.lastMatchArchive=null;retainedMatchArchive=null;
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
       retainedMatchArchive=runtime.adapter?.lastMatchArchive??retainedMatchArchive;
       if(ended&&autoRematch===false){matchCompleted=true;break;}
       // Rebind without forgetting the rejected round; do not repeatedly submit its initial action.
       state=new WaitingState(options.initialScores);
       state.postMatch=ended;
       postMatchFlow=ended;
       if(signal.aborted)break;
       if(rediscover){await delay(1000,null,{signal}).catch(()=>{});continue;}
       capture=makeCapture(window,join(base,'waiting-frame.bmp'));await capture.ready;
       adapter=makeAdapter(capture,window);adapter.restoreMatchArchive=retainedMatchArchive;await adapter.ready;bound=window;
       adapter.restoreMatchArchive=retainedMatchArchive;
      }
     }else{
      const action=await startFlow.step(probe,adapter);
      if(action)await status(`开局操作已发送：${startActionName[action]} (${startFlow.index}/${startFlow.actions.length})`,{},false);
      else if(startFlow.finished||startFlow.index===startFlow.actions.length)
       await status(phase==='settlement'?'正在读取结算':state.round?'局面暂未识别清楚，继续识别当前局':'等待进入对局');
     }
    }
   }catch(error){if(['STARTUP_CHECK_FAILED','NO_PROGRESS_LIMIT'].includes(error.code))throw error;await status(`等待恢复：${error.message}`);await close();}
   if(!signal.aborted)await delay(pollDelay(performance.now()-cycleStart,options.pollMs),null,{signal}).catch(e=>{if(e.name!=='AbortError')throw e;});
  }
 }catch(error){startupFailure=error;throw error;}finally{
  statusLog.close();
  discovery?.close();
  let cleanupError;
  try{await close();}catch(error){cleanupError=error;}
  try{await lock.close();}finally{await unlink(lockPath);}
  await status(startupFailure?startupFailure.message:matchCompleted?'整场对局已结束，听风执牌已停止':'听风执牌运行已停止',{status:startupFailure?'startup_failed':matchCompleted?'match_ended':'stopped',startup:startup.report,...(cleanupError?{cleanupError:cleanupError.message}:{})},false);
  if(startupFailure)startupFailure.reported=true;
  if(!options.signal){process.off('SIGINT',stop);process.off('SIGTERM',stop);}
  if(cleanupError&&!startupFailure)throw cleanupError;
 }
}
export function parseResidentArgs(args){
 let version;
 args=args.filter(a=>{
  if(!['--64','--66','--67','--68'].includes(a))return true;
  if(version!==undefined)throw Error('--64 / --66 / --67 / --68 只能选择一次');
  version=a.slice(2);return false;
 });
 const paths=args.filter(a=>!['-b','-g','-d','-s'].includes(a));
 if(paths.length>1||paths.some(a=>a.startsWith('-')))throw Error('用法：node resident.mjs [配置文件绝对路径] [--64|--66|--67|--68] [-b|-g] [-d]');
 if(args.includes('-b')&&args.includes('-g'))throw Error('-b 与 -g 不能同时选择：铜之间／金之间');
 return {configPath:paths[0]??null,briefPostMatch:args.includes('-b'),singleMatch:false,saveAllScreenshots:args.includes('-d'),...(args.includes('-g')?{goldRoom:true}:{}),...(version?{version}:{})};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const cli=parseResidentArgs(process.argv.slice(2));
 const options=cli.configPath?JSON.parse(await readFile(cli.configPath,'utf8')):{};
 if(cli.version)options.executable=fileURLToPath(new URL(`./engines/v${cli.version}-parallel-3p3/bot.exe`,import.meta.url));
 options.briefPostMatch=cli.briefPostMatch;
 options.goldRoom=cli.goldRoom===true;
 options.singleMatch=cli.singleMatch;
 options.saveAllScreenshots=cli.saveAllScreenshots;
 options.startupArgs=process.argv.slice(2);
 runResident(options).catch(e=>{if(!e.reported)console.error(e.message);process.exitCode=1;});
}
