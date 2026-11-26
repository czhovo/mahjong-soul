import {GAME,remainingHands} from './game-rules.mjs';
import {applyKitaDecision} from './auto-kita.mjs';
import {automaticNorthDraw,singleNorthReady} from './auto-kita-effect.mjs';
import {KitaEvidence} from './kita-evidence.mjs';
import {blocksTsumoDiscard} from './tsumo-guard.mjs';
import {modalStatus} from './modal-status.mjs';
import {modalTextResult} from './modal-text-results.mjs';
import {appendEvidence,flushEvidence} from './background-evidence.mjs';
import {DiscardEvidence} from './discard-evidence.mjs';
import {CallWaitEvidence} from './call-wait-evidence.mjs';
import {SearchBudget} from './search-budget.mjs';
import {spawn,execFile} from 'node:child_process';
import {readFile,writeFile,mkdir,copyFile,link} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,join,extname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildClickRequest} from './ahk-output.mjs';
import {CallSequence} from './call-sequence.mjs';
import {plannedCallChoice} from './planned-call-choice.mjs';
import {visibleContext} from './visible-context.mjs';
import {SpecialSequence} from './special-sequence.mjs';
import {PointLedger} from './point-ledger.mjs';
import {publicEvents} from './public-events.mjs';
import {AhkDriver} from './ahk-driver.mjs';
import {visibleActions} from './visible-actions.mjs';
import {verifyWinSettlement} from './win-settlement.mjs';
import {discardTarget} from './discard-target.mjs';
import {completeFrameScores} from './complete-scores.mjs';
import {VERSIONS} from './version-info.mjs';
import {DEFAULT_PYTHON} from './runtime-paths.mjs';

const ROOT=dirname(fileURLToPath(import.meta.url));
// Recognition workers/adapters can be replaced between the table and results.
// Keep the glyphs only in this resident process, scoped to the game window.
const nicknameByWindow=new Map();
const same=(a,b)=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
const freshObservationRequired=message=>Object.assign(Error(message),{code:'FRESH_OBSERVATION_REQUIRED',inputNotSent:true});
export class ClientAdapter {
  constructor(sky,window,{python=DEFAULT_PYTHON,recognitionTimeoutMs=null,initializationTimeoutMs=15000}={}) {
    this.sky=sky;this.window=window;this.pending=new Map();
    this.searchBudget=new SearchBudget();
    if(GAME.sanma)this.kitaEvidence=new KitaEvidence();
    this.python=python;
    this.recognitionTimeoutMs=recognitionTimeoutMs;this.initializationTimeoutMs=initializationTimeoutMs;
    this.startRecognitionWorker();
  }
  startRecognitionWorker(){
    this.restoreNicknameOnRequest=true;
    const {python}=this;
    this.workerError=null;
    this.ready=new Promise((resolve,reject)=>{this.readyResolve=resolve;this.readyReject=reject;});
    this.ready.catch(()=>{});
    this.readyTimer=this.initializationTimeoutMs===null?null:setTimeout(()=>this.fail(Error('Recognition worker initialization timeout')),this.initializationTimeoutMs??15000);
    const workerPath=fileURLToPath(new URL('./recognition-worker.py',import.meta.url));
    const worker=this.worker=spawn(python,['-u',workerPath],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,MAJSOUL_CONTROLLER_ROOT:ROOT}});
    worker.stdout.setEncoding('utf8');
    worker.stderr.setEncoding('utf8');
    let buffer='';this.stderr='';
    worker.stderr.on('data',b=>{if(this.worker===worker)this.stderr=(this.stderr+b).slice(-16384);});
    worker.stdin.on('error',e=>{if(this.worker===worker)this.fail(e);});
    worker.stdout.on('data',b=>{if(this.worker!==worker)return;buffer+=b;let n;while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);try{const result=JSON.parse(line);if(result.type==='ready'){
      if(result.recognizer_version!==VERSIONS.recognize)throw Error(`Expected recognize ${VERSIONS.recognize}, received ${result.recognizer_version}`);
      this.recognizerVersion=result.recognizer_version;
      clearTimeout(this.readyTimer);this.readyResolve();continue;
    }this.receiveRecognitionResult(result);}catch(e){this.fail(e);}}});
    worker.on('error',e=>{if(this.worker===worker)this.fail(e);});
    worker.on('exit',code=>{if(this.worker===worker)this.fail(Error(`Recognition worker exited ${code}: ${this.stderr.slice(-1000)}`));});
  }
  receiveRecognitionResult(result){
    if(result.nicknameUpdate){
      if(this.window?.id)nicknameByWindow.set(this.window.id,result.nicknameUpdate);
      delete result.nicknameUpdate;
    }
    const request=this.pending.get(result.id);
    if(request){
      this.pending.delete(result.id);clearTimeout(request.timer);
      result.error?request.reject(Object.assign(Error(result.error),{code:result.errorCode,site:result.errorSite})):request.resolve(result);
    }
  }
  async ensureRecognitionReady(){
    if(this.recognitionClosed)throw Error('Recognition adapter closed');
    if(!this.worker)this.startRecognitionWorker();
    await this.ready;
    if(this.workerError)throw this.workerError;
  }
  async stopRecognitionWorker(){
    const worker=this.worker;
    this.worker=null;clearTimeout(this.readyTimer);
    if(!worker||worker.exitCode!==null||worker.signalCode!==null)return;
    await new Promise((resolve,reject)=>{
      worker.once('exit',resolve);worker.once('error',reject);
      worker.kill();
    });
  }
  async withRecognition(action){
    const previous=this.recognitionLock??Promise.resolve();
    const task=previous.catch(()=>{}).then(async()=>{await this.ensureRecognitionReady();return action();});
    this.recognitionLock=task;
    try{return await task;}finally{if(this.recognitionLock===task)this.recognitionLock=null;}
  }
  recognitionRequest(payload){
    return new Promise((resolve,reject)=>{
      const timer=this.recognitionTimeoutMs==null?null:setTimeout(()=>{
        this.pending.delete(payload.id);
        this.latest=null;
        // Do not release the serial lock until the timed-out computation exits.
        this.stopRecognitionWorker().then(()=>{
          if(!this.recognitionClosed)this.startRecognitionWorker();
          reject(Error('Recognition timeout'));
        }).catch(reject);
      },this.recognitionTimeoutMs);
      this.pending.set(payload.id,{resolve,reject,timer});
      if(this.restoreNicknameOnRequest){
        this.restoreNicknameOnRequest=false;
        if(nicknameByWindow.has(this.window?.id))
          payload={...payload,restoreNickname:nicknameByWindow.get(this.window.id)};
      }
      this.worker.stdin.write(JSON.stringify({...payload,game:GAME.sanma?'sanma':'yonma'})+'\n');
    });
  }
  fail(error){this.workerError=error;clearTimeout(this.readyTimer);this.readyReject?.(error);for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(error);}this.pending.clear();}
  async close(){this.recognitionClosed=true;this.fail(Error('Recognition adapter closed'));await this.stopRecognitionWorker();try{await this.outputDriver?.close();}finally{await flushEvidence();}}
  async prepareOutput(){
    if(!this.outputDriver)this.outputDriver=new AhkDriver(GAME.runtimeRoot??ROOT);
    await this.outputDriver.start();
  }
  initializePoints(scores,riichiSticks=0,seats=Object.fromEntries(GAME.positions.map((p,i)=>[p,i]))){
    if(this.points)throw Error('Point ledger already initialized');
    this.points=new PointLedger(scores,riichiSticks);
    this.roundStartRiichiSticks=riichiSticks;
    if(this.latest?.round?.counters)this.latest.round.counters.round_start_riichi_sticks=riichiSticks;
    this.pointSeats={...seats};
  }
  resetMatchState(){
    // Workers and the AHK driver survive the match. Hand-specific evidence
    // and points must not survive into a later match with the same East-1 key.
    this.points=null;this.pointSeats=null;this.roundStartRiichiSticks=undefined;
    this.call=null;this.publicFrameId=null;
    delete this.autoWinOutput;delete this.autoKitaOutput;
    this.discardEvidence=new DiscardEvidence();
    this.callWaitEvidence=new CallWaitEvidence({enabled:this.naku===true,onDetected:event=>this.onCallWaitDetected?.(event)});
    if(GAME.sanma)this.kitaEvidence=new KitaEvidence();
  }
  acceptRiichi(event){
    if(!this.points)throw Error('Opening point checkpoint required');
    this.points.acceptRiichi(event);
  }
  observePublicTransition(session,before,after=this.latest,call=null){
    if(after!==this.latest||!after?.hand.complete)throw Error('Current complete observation required');
    if(session.pending||this.call)throw Error('Resolve pending own action first');
    if(this.publicFrameId&&this.publicFrameId!==before.id)throw Error('Public observation does not continue the committed frame');
    if(before.id===after.id||this.publicFrameId===after.id)throw Error('Public observation already committed');
    const seats=after.round?.seat_identity;
    if(!seats?.verified||seats.seats.self!==session.seat)throw Error('Verified session seat required');
    const metadata=call?{...call,lastDiscard:{seat:session.ledger.lastPlayer,tile:session.ledger.lastDiscard}}:null;
    const transition=publicEvents(before,after,seats.seats,metadata);
    if(!transition.verified)return transition;
    // Deposit handling needs its point checkpoint; do not partially ingest it.
    if(transition.acceptedRiichi&&!this.points)throw Error('Opening point checkpoint required');
    const nextPoints=transition.acceptedRiichi?Object.assign(Object.create(PointLedger.prototype),structuredClone(this.points)):null;
    if(nextPoints)nextPoints.acceptRiichi(transition.acceptedRiichi);
    session.observeVerified(transition,after.hand.tiles.map(t=>t.tile));
    if(nextPoints)this.points=nextPoints;
    this.publicFrameId=after.id;
    return transition;
  }
  recordSettlement({settlementId,seats,riichiSticks,confirmed},frame=this.latest){
    if(!this.points||frame!==this.latest||!frame?.settlement?.complete)
      throw Error('Current complete settlement observation required');
    const positions=GAME.positions;
    const identities=positions.map(p=>seats?.[p]);
    if(identities.some(s=>!Number.isInteger(s)||s<0||s>=GAME.players)||new Set(identities).size!==GAME.players)
      throw Error('Four distinct seat identities required');
    const scores=[];
    for(const p of positions)scores[seats[p]]=frame.settlement.scores[p].value;
    this.points.settle({settlementId,scores,riichiSticks,confirmed});
    this.pointSeats={...seats};
    return this.points.snapshot(frame.id);
  }
  async inspect(layout){
    let reported=false;
    for(;;){
      try{return await this.withRecognition(()=>this.inspectUnlocked(layout));}
      catch(error){
        if(error.code!=='EMPTY_COLOR_INPUT'||!this.captureSource||this.recognitionClosed)throw error;
        if(!reported){
          (this.onRecognitionStatus??console.warn)(`识别区域为空，读取下一帧：${error.site}`);
          reported=true;
        }
        // inspectUnlocked already advanced captureSequence. Reacquire instead
        // of reusing the failed pixels or handing an empty result to the ledger.
      }
    }
  }
  async inspectUnlocked(layout){
    // Finish process/import initialization before obtaining the input frame;
    // the per-frame deadline measures processing, not interpreter startup.
    await this.ready;
    this.observationDirectoryReady??=mkdir(join(GAME.runtimeRoot??ROOT,'observations'),{recursive:true});
    await this.observationDirectoryReady;
    const started=performance.now();
    if(this.workerError)throw this.workerError;
    let capture,state;
    for(;;){
      capture=this.captureSource?await this.captureSource.next(this.captureSequence??0,this.inputCompletedMono??-Infinity):null;
      if(capture)this.captureSequence=capture.sequence;
      state=capture?.state??await this.sky.get_window_state({window:this.window});
      if(!state.captureEvidence?.modalConfirm?.verified)break;
      await this.dismissModal(state);
    }
    const observationEpoch=this.outputEpoch??0;
    const captured=performance.now();
    this.window=state.window;
    const capturedAt=capture?.capturedAt??Date.now();const screenshot=state.screenshots[0];
    if(!screenshot||screenshot.height<600||Math.abs((screenshot.width-2)/(screenshot.height-32)-1366/768)>.004)throw Error('Uncalibrated screenshot dimensions');
    const id=randomUUID();
    // Delta archives reference same-directory immutable base frames. Retain
    // their original path; copying a single member would break its chain.
    const archive=screenshot.path&&extname(screenshot.path)==='.mjc';
    const memoryOnly=!!state.captureEvidence?.frameMemory&&!screenshot.path;
    const transient=layout.persistEvidence===false;
    if(transient&&!screenshot.path&&!memoryOnly)throw Error('Transient inspection requires local capture');
    const path=memoryOnly?null:archive||transient?screenshot.path:join(GAME.runtimeRoot??ROOT,'observations',id+(screenshot.path?extname(screenshot.path):'.png'));
    if(memoryOnly||archive||transient){ /* Shared-memory frames do not create image files. */ }
    else if(screenshot.path){
      // Native captures are immutable UUID files. Preserve both evidence paths
      // without storing a second full bitmap on the same volume.
      try{await link(screenshot.path,path);}catch(error){
        if(!['EXDEV','ENOTSUP','EPERM'].includes(error.code))throw error;
        await copyFile(screenshot.path,path);
      }
    }
    else await writeFile(path,Buffer.from(screenshot.url.split(',')[1],'base64'));
    const recognitionStarted=performance.now();
    const result=await this.recognitionRequest({id,image:path,frameMemory:state.captureEvidence?.frameMemory,capturedAt,beginMatchArchive:this.beginMatchArchive,...layout});
    this.beginMatchArchive=false;
    if(this.modalOutput||observationEpoch!==(this.outputEpoch??0))throw freshObservationRequired('Observation interrupted by priority input; capture again');
    if(result.modal_confirm?.verified){await this.dismissModal({...state,captureEvidence:{...state.captureEvidence,modalConfirm:result.modal_confirm}});return this.inspectUnlocked(layout);}
    await this.confirmModalCleared(state.captureEvidence?.capturedAt??capturedAt);
    completeFrameScores(result,this.points?.bank??GAME.bank);
    if(result.round?.counters&&Number.isInteger(this.roundStartRiichiSticks))
      result.round.counters.round_start_riichi_sticks=this.roundStartRiichiSticks;
    const recognized=performance.now(),recognitionCompletedAt=Date.now();
    const timing={recognitionReused:false,captureMs:capture?.captureMs??captured-started,imageWriteMs:recognitionStarted-captured,recognitionMs:recognized-recognitionStarted,totalMs:recognized-started,...(capture?{captureAgeMs:captured-capture.capturedMono,sourceSequence:capture.sequence,sourcePath:capture.path}:{})};
    const observation={...result,imagePath:path,timing,capturedAt,captureStartedMono:capture?capture.capturedMono-capture.captureMs:started,screenshotId:screenshot.id,clientWidth:screenshot.width-2,clientHeight:screenshot.height-32,state};
    this.discardEvidence??=new DiscardEvidence();
    observation.discardMotion=state.captureEvidence?.discardMotion??[];
    this.discardEvidence.update(observation,observation.discardMotion);
    this.callWaitEvidence??=new CallWaitEvidence({enabled:this.naku===true,onDetected:event=>this.onCallWaitDetected?.(event)});
    observation.recognizer_version=result.recognizer_version??this.recognizerVersion;
    result.recognizer_version=observation.recognizer_version;
    observation.capture_stall={active:capture?.stalled===true,lastAt:capture?.lastStallAt??null};
    this.callWaitEvidence.enabled=this.naku===true;
    observation.opponent_hand_constraints=this.callWaitEvidence.observe(observation);
    result.opponent_hand_constraints=observation.opponent_hand_constraints;
    this.kitaEvidence?.observe(observation);
    this.latest=observation;
    this.searchBudget.observeFrame(observation,layout);
    timing.captureWaitMs=captured-started;
    timing.recognitionCompletedAt=recognitionCompletedAt;
    timing.observationReadyAt=Date.now();
    if(!transient)appendEvidence(join(GAME.runtimeRoot??ROOT,'observations','index.jsonl'),JSON.stringify({id,imagePath:path,capturedAt,layout,result,timing,discardMotion:observation.discardMotion})+'\n');
    return observation;
  }
  async probeControls(afterSequence=this.captureSequence??0,{signal}={}){
    if(!this.captureSource||this.recognitionClosed||signal?.aborted)return null;
    let capture;
    try{
      const nextPromise=this.captureSource.next(afterSequence,this.inputCompletedMono??-Infinity);
      if(signal){
        let onAbort;
        const abortPromise=new Promise(resolve=>{
          if(signal.aborted){resolve(null);return;}
          onAbort=()=>resolve(null);
          signal.addEventListener('abort',onAbort,{once:true});
        });
        capture=await Promise.race([nextPromise,abortPromise]);
        if(onAbort)signal.removeEventListener('abort',onAbort);
        nextPromise.catch(()=>{});
      }else{
        capture=await nextPromise;
      }
    }catch{return null;}
    if(!capture||signal?.aborted||this.recognitionClosed)return null;
    const state=capture.state;
    const screenshot=state?.screenshots?.[0];
    const frameMemory=state?.captureEvidence?.frameMemory;
    if(!screenshot||(!screenshot.path&&!frameMemory))return {sequence:capture.sequence,controls:{}};
    try{
      const result=await this.withRecognition(async()=>{
        if(signal?.aborted||this.recognitionClosed)return null;
        await this.ready;
        if(this.workerError)return null;
        return this.recognitionRequest({
          id:randomUUID(),phase:'controls',
          image:frameMemory?null:screenshot.path,
          frameMemory,capturedAt:capture.capturedAt,
        });
      });
      if(!result)return null;
      return {sequence:capture.sequence,controls:result.controls??{},auto_win:result.auto_win,auto_kita:result.auto_kita};
    }catch{return null;}
  }
  async refineRivers(observation){return this.withRecognition(()=>this.refineRiversUnlocked(observation));}
  async refineRiversUnlocked(observation){
    if(observation!==this.latest||(!observation.imagePath&&!observation.state?.captureEvidence?.frameMemory))throw Error('Refinement requires latest observation');
    const started=performance.now(),id=randomUUID();
    const result=await this.recognitionRequest({id,image:observation.imagePath,frameMemory:observation.state?.captureEvidence?.frameMemory,phase:'rivers'});
    observation.rivers=result.rivers;
    this.discardEvidence??=new DiscardEvidence();
    this.discardEvidence.update(observation,observation.discardMotion??[]);
    const elapsed=performance.now()-started;
    observation.timing.recognitionMs+=elapsed;
    observation.timing.riverRefinementMs=elapsed;
    appendEvidence(join(GAME.runtimeRoot??ROOT,'observations','river-refinements.jsonl'),JSON.stringify({observationId:observation.id,imagePath:observation.imagePath,rivers:result.rivers,elapsedMs:elapsed})+'\n');
    return observation;
  }
  async discard(decision,observation=this.latest){
    if(!this.kokushiRoute?.active&&automaticNorthDraw(observation,this.autoKitaOutput))throw freshObservationRequired('自动拔北中，等待补摸');
    if(blocksTsumoDiscard(observation,{kokushiRouteActive:this.kokushiRoute?.active===true}))throw Object.assign(Error('Winning hand observed; wait for auto-win settlement instead of discarding'),{inputNotSent:true});
    if(observation!==this.latest||!observation?.hand.complete)throw freshObservationRequired('Current complete hand required');
    if(decision.observationId!==observation.id)throw freshObservationRequired('Decision is not bound to this input observation');
    const [action,tile,...extra]=decision.output.response.trim().split(/\s+/);
    if(action!=='PLAY'||extra.length)throw Error('Only an ordinary discard is handled here');
    if(!same(decision.visibleHand,observation.hand.tiles.map(t=>t.tile)))throw freshObservationRequired('Decision hand differs from current frame');
    const position=discardTarget(observation.hand.tiles,tile);
    if(!position)throw freshObservationRequired('Discard missing');
    // Allow the authorized five-second bot calculation using the ORIGINAL
    // input's coordinates. Do not capture/recognize again after deciding.
    return this.sendClick(observation,position.center,decision.retryInput?"retry":"tile");
  }
  async pass(decision,observation=this.latest,{retryVisibleButton=false}={}){
    if(!observation||observation!==this.latest||(!retryVisibleButton&&!observation.hand?.complete))throw freshObservationRequired('Current complete reaction hand required');
    if(decision.observationId!==observation.id)throw freshObservationRequired('Decision is not bound to this input observation');
    if(decision.output.response.trim()!=='PASS')throw Error('Expected PASS decision');
    if(observation.hand?.complete&&!same(decision.visibleHand,observation.hand.tiles.map(t=>t.tile)))throw freshObservationRequired('Decision hand differs from current frame');
    const control=observation.controls?.PASS;
    if(!control)throw freshObservationRequired('No verified skip button in input frame');
    return this.sendClick(observation,[control.center[0],control.center[1]+18]);
  }
  callObservation(frame,publicState){
    if(frame!==this.latest||!frame?.hand.complete)throw freshObservationRequired('Current complete hand required');
    if(publicState?.observationId!==frame.id||!publicState.verified)throw Error('Verified public state must belong to the input frame');
    return {...publicState,hand:frame.hand.tiles.map(t=>t.tile),
      ...(frame.selection?.verified?{legalDiscards:frame.selection.legalDiscards}:{}),
      ...(frame.call_choices?.verified?{choices:frame.call_choices.choices}:{}),
      screenshotId:frame.screenshotId,controls:frame.controls,
      handLocations:frame.hand.tiles};
  }
  async execute(decision,frame=this.latest,publicState){
    if(this.call)throw Error('Finish the pending call before another decision');
    const kind=decision.output.response.trim().split(/\s+/)[0];
    if(GAME.sanma&&kind==='CHI')throw Error('三人场不能吃牌');
    if(kind==='PLAY')return this.discard(decision,frame);
    if(kind==='PASS')return this.pass(decision,frame);
    if(!['CHI','PENG','LIZHI','GANG','ANGANG','BUGANG','KITA'].includes(kind))throw Error(`Action not implemented: ${kind}`);
    if(decision.observationId!==frame?.id)throw freshObservationRequired('Decision is not bound to this input observation');
    let sequence,target;
    const singleNorth=kind==='KITA'&&(decision.singleNorth||this.kokushiRoute?.active);
    const useSingleNorthButton=singleNorth&&!decision.autoKitaFallback&&singleNorthReady(frame);
    const useAutoKita=kind==='KITA'&&GAME.sanma&&!useSingleNorthButton;
    if(useSingleNorthButton)decision.singleNorth=true;
    else if(singleNorth&&useAutoKita){decision.autoKitaFallback=true;decision.singleNorth=false;}
    try{
      const observation=this.callObservation(frame,publicState);
      if(GAME.sanma)observation.kitaCount=frame.kita?.self?.count;
      if(!same(decision.visibleHand,observation.hand))throw freshObservationRequired('Decision hand differs from input frame');
      sequence=['CHI','PENG'].includes(kind)?new CallSequence(decision.output.response,{...observation,allowDeferredDiscard:!!decision.callSearch},publicState.lastDiscarder):new SpecialSequence(decision.output.response,observation);
      if(!useAutoKita)target=sequence.target(observation);
    }catch(error){
      if(kind==='KITA')throw freshObservationRequired(error.message);
      // All work above precedes call registration and mouse output. Let the
      // live cycle discard the unsent decision instead of retaining an
      // orphan session.pending that can never receive a game confirmation.
      throw Object.assign(error,{inputNotSent:true});
    }
    // Keep the transaction even on an uncertain AHK acknowledgement; never
    // automatically repeat an input that might already have reached the game.
    if(useAutoKita){
      // The client performs the extraction. Preserve the decision until its
      // public effect is confirmed, even when the switch is already green.
      this.call={sequence,decision,uncertain:false};
      try{
        const toggle=await applyKitaDecision(frame,this,{allowKokushiFallback:!!decision.autoKitaFallback});
        sequence.inputSent(); // switch sent, already enabled, or an earlier toggle is pending
        return toggle;
      }
      catch(error){
        if(error.outputOutcomeUnknown)sequence.inputSent();
        if(!error.inputNotSent||error.outputOutcomeUnknown)throw error;
        this.call=null;
        throw error;
      }
    }
    this.call={sequence,decision,uncertain:true};
    try{
      return await this.sendCallInput(frame,[target.center[0],target.center[1]+18]);
    }catch(error){
      if(error.inputNotSent&&!error.outputOutcomeUnknown&&this.call?.decision===decision)this.call=null;
      throw error;
    }
  }
  async sendCallInput(frame,center,retryInput=false){
    const call=this.call;
    const phase=call.sequence.phase;
    const riichiBatch=phase==='button'&&call.sequence.kind==='LIZHI';
    const followUp=riichiBatch?discardTarget(frame.hand.tiles,call.sequence.tile):phase==='call'&&call.sequence instanceof CallSequence?plannedCallChoice(call.sequence,frame):null;
    if(riichiBatch&&!followUp)throw freshObservationRequired('Riichi discard missing');
    if(followUp){center=[...center];center.followUp=followUp.center;}
    const advance=()=>{call.sequence.inputSent();if(followUp)call.sequence.inputSent();if(riichiBatch)call.riichiBatch=true;};
    call.lastInput={phase,frame:structuredClone(frame)};
    call.uncertain=true;
    try{
      const targetKind=riichiBatch?"ui_then_tile":phase==="discard"||(phase==="selection"&&call.sequence.kind==="LIZHI")?"tile":"ui";
      const receipt=await this.sendClick(frame,center,retryInput&&targetKind==="tile"?"retry":targetKind);
      advance();call.uncertain=false;call.receiptUnknown=false;
      return receipt;
    }catch(error){
      if(error.outputOutcomeUnknown){
        // Advance only to effect observation, never to confirmed completion.
        // A lost receipt must retain the stage that can verify the next frame.
        advance();call.uncertain=false;call.receiptUnknown=true;
        call.unknownInput={phase,frame:structuredClone(frame)};
      }else if(error.inputNotSent)call.uncertain=false;
      throw error;
    }
  }
  async saveRebuildScreenshot(frame,evidence){return this.withRecognition(()=>this.saveRebuildScreenshotUnlocked(frame,evidence));}
  async saveRebuildScreenshotUnlocked(frame,evidence){
    if(frame.savedRebuildScreenshot)return frame.savedRebuildScreenshot;
    if(!frame.imagePath&&!frame.state?.captureEvidence?.frameMemory)throw Error('Rebuild trigger frame has no pixels');
    await this.ready;
    const id=randomUUID();
    const result=await this.recognitionRequest({id,phase:'save_rebuild',image:frame.imagePath,frameMemory:frame.state?.captureEvidence?.frameMemory,observationId:frame.id,capturedAt:frame.capturedAt,
      evidence:{...evidence,sourceImage:frame.imagePath,observation:frame,rawObservation:this.latest?.id===frame.id?this.latest:undefined}});
    frame.savedRebuildScreenshot=result.saved;
    return result.saved;
  }
  async continueCall(frame=this.latest,publicState){
    if(!this.call||this.call.uncertain)throw Error('No confirmed pending call input');
    const {sequence,decision}=this.call;
    if(sequence.kind==='KITA'&&GAME.sanma&&!decision.singleNorth)return applyKitaDecision(frame,this,{allowKokushiFallback:!!decision.autoKitaFallback});
    if(decision.singleNorth&&!publicState.actionCompleted&&!singleNorthReady(frame))throw freshObservationRequired('等待确认自动拔北关闭且手中至少有两张北');
    const observation=this.callObservation(frame,publicState);
    if(GAME.sanma)observation.kitaCount=frame.kita?.self?.count;
    if(['LIZHI','GANG','ANGANG','BUGANG','KITA'].includes(sequence.kind)){
      if(publicState.actionCompleted){
        sequence.verify(observation);this.call=null;
        return {gameConfirmed:true,action:decision.output.response};
      }
      const target=sequence.target(observation);
      // Button retries use the same hit point as their original send. Tile
      // and combination selections keep their own exact recognized centers.
      return this.sendCallInput(frame,sequence.phase==='button'?[target.center[0],target.center[1]+18]:target.center,publicState.retryInput);
    }
    if(sequence.phase==='await_discard'||(publicState.actionCompleted&&sequence.phase==='discard')){
      if(sequence.phase==='discard')sequence.phase='await_discard';
      sequence.verifyDiscard(observation);
      this.call=null;
      return {gameConfirmed:true,action:decision.output.response};
    }
    if(['await_meld','await_choice_effect'].includes(sequence.phase)&&observation.melds.length===sequence.before.melds.length+1)
      sequence.verifyMeld(observation);
    const target=sequence.target(observation);
    return this.sendCallInput(frame,sequence.phase==='call'?[target.center[0],target.center[1]+18]:target.center,publicState.retryInput);
  }
  confirmWinSettlement(before,frame=this.latest){
    if(frame!==this.latest||!this.call||this.call.uncertain||this.call.sequence.kind!=='HU')
      throw Error('Current settlement and sent win transaction required');
    const proof=verifyWinSettlement(this.call.decision,before,frame);
    this.call.sequence.verify(proof);
    this.call=null;
    return proof;
  }
  async recheckEndButtons(){
    await this.prepareOutput();
    return this.inspect({phase:'post_match',persistEvidence:false});
  }
  async sendClick(observation,center,targetKind="ui"){
    if(this.modalOutput)throw freshObservationRequired('Central dialog has input priority');
    const epoch=this.outputEpoch??0,transaction={queued:false};
    try{return await this.withOutputLock(()=>this.sendClickUnlocked(observation,center,epoch,transaction,targetKind));}
    catch(error){
      if(epoch!==(this.outputEpoch??0)){
        if(transaction.queued){delete error.inputNotSent;error.outputOutcomeUnknown=true;}
        else {error.inputNotSent=true;if(this.call)this.call.uncertain=false;}
      }
      throw error;
    }
  }
  async withOutputLock(action){
    const epoch=this.outputEpoch??0;
    const previous=this.outputLock??Promise.resolve();
    const current=previous.catch(()=>{}).then(async()=>{
      if(this.modalOutput)throw freshObservationRequired('Central dialog has input priority');
      if(this.priorityOutput)await this.priorityOutput;
      if(epoch!==(this.outputEpoch??0))throw freshObservationRequired('Queued input cancelled by priority title click');
      return action();
    });
    this.outputLock=current;
    try{return await current;}finally{if(this.outputLock===current)this.outputLock=null;}
  }
  async clickRecovery(action){
    if(this.modalOutput)return false;
    return action();
  }
  async dismissModal(state){
    if(this.modalOutput)return this.modalOutput;
    const dialog=state.captureEvidence?.modalConfirm,shot=state.screenshots?.[0];
    if(!dialog?.verified||!shot)return false;
    const task=Promise.resolve().then(async()=>{
      if(!this.modalDetected){
        this.modalDetected=true;
        this.modalNotice={text:dialog.text,modalTextId:dialog.modalTextId,clicked:false};
        await this.recordModal({kind:'modal_detected',center:dialog.center,text:dialog.text,textConfidence:dialog.text_confidence,textError:dialog.text_error});
      }
      if(dialog.text&&this.modalNotice)this.modalNotice.text=dialog.text;
      if(dialog.modalTextId&&this.modalNotice&&!this.modalNotice.modalTextId)this.modalNotice.modalTextId=dialog.modalTextId;
      // An already executing recovery must finish; it must not swallow this
      // higher-priority request by returning its own receipt in our place.
      await this.priorityOutput?.catch(()=>{});
      return this.runPriorityOutput(async()=>{
        const frame={id:randomUUID(),screenshotId:shot.id,clientWidth:shot.width-2,clientHeight:shot.height-32,capturedAt:Date.now(),modalConfirm:true};
        this.latest=frame;
        try{
          const receipt=await this.sendClickUnlocked(frame,dialog.center);
          this.modalNotice={...this.modalNotice,clicked:true,sentAt:Date.now()};
          await this.recordModal({kind:'modal_confirm',center:dialog.center,receipt});
          return receipt;
        }catch(error){
          if(!error.inputNotSent&&!error.outputOutcomeUnknown)throw error;
          await this.recordModal({kind:'modal_confirm_retry_frame',reason:error.message});
          return false;
        }
      });
    });
    this.modalOutput=task;
    try{return await task;}finally{this.modalOutput=null;this.latest=null;}
  }
  async runPriorityOutput(action){
    if(this.priorityOutput)return this.priorityOutput;
    this.outputEpoch=(this.outputEpoch??0)+1;
    const priority=Promise.resolve().then(async()=>{
      // Only finish publishing an in-flight queue file, never wait for the
      // ordinary action or its visual confirmation before priority recovery.
      await this.enqueueTask?.catch(()=>{});
      const driver=this.outputDriver;
      if(driver){await driver.retireQueue('Priority title click');if(this.outputDriver===driver)this.outputDriver=null;}
      this.latest=null;
      return action();
    });
    this.priorityOutput=priority;
    try{return await priority;}finally{if(this.priorityOutput===priority)this.priorityOutput=null;}
  }
  async recordModal(event){
    const message=modalStatus(event);
    if(message)this.onModalStatus?.(message);
    appendEvidence(join(GAME.runtimeRoot??ROOT,'queue','modal-actions.jsonl'),JSON.stringify({at:new Date().toISOString(),...event})+'\n');
  }
  async confirmModalCleared(capturedAt){
    const notice=this.modalNotice;
    if(!notice||this.modalOutput)return;
    if(notice.clicked&&(!Number.isFinite(capturedAt)||capturedAt<=notice.sentAt))return;
    this.modalNotice=null;this.modalDetected=false;
    if(notice.clicked){
      if(!notice.text&&notice.modalTextId){
        void modalTextResult(notice.modalTextId).then(result=>this.recordModal({kind:'modal_resolved',text:result?.text,capturedAt})).catch(()=>{});
      }else await this.recordModal({kind:'modal_resolved',text:notice.text,capturedAt});
    }
  }
  async sendClickUnlocked(observation,center,epoch=this.outputEpoch??0,transaction={queued:false},targetKind="ui"){
    if(observation!==this.latest)throw freshObservationRequired('Input observation already consumed');
    await this.prepareOutput();
    if(epoch!==(this.outputEpoch??0))throw freshObservationRequired('Input cancelled by priority title click');
    let req;
    // Calculation time alone does not invalidate a decision. Keep its bound
    // observation and coordinates; do not restart the same calculation by age.
    try{
      req=buildClickRequest(observation,{screenshotId:observation.screenshotId,targetKind,x:Math.round(center[0]-1),y:Math.round(center[1]-31),...(center.followUp?{followUp:{x:Math.round(center.followUp[0]-1),y:Math.round(center.followUp[1]-31)}}:{}),doubleClick500:center.doubleClick500===true,modalConfirm:observation.modalConfirm===true},Infinity);
    }catch(error){
      if(error.code==='STALE_OBSERVATION')this.latest=null;
      if(error.inputNotSent&&this.call)this.call.uncertain=false;
      throw error;
    }
    if(epoch!==(this.outputEpoch??0))throw freshObservationRequired('Input cancelled by priority title click');
    this.latest=null;
    transaction.queued=true;
    let ack;
    try{ack=await this.outputDriver.send(req.id,req.line,req.timeoutMs);}catch(error){
      if(error.inputNotSent){
        if(this.call)this.call.uncertain=false;
        throw error;
      }
      if(/\tpartial_input\t/.test(error.message)){error.outputOutcomeUnknown=true;this.inputCompletedMono=performance.now();}
      if(epoch!==(this.outputEpoch??0))throw Object.assign(error,{outputOutcomeUnknown:true});
      if(/AHK receipt timeout|AHK worker exited/.test(error.message)){
        const cause=error.message;
        await this.outputDriver.retireQueue(error.message);this.outputDriver=null;
        error.message='AHK output interrupted; queue retired; reacquire current frame; cause: '+cause;
        error.outputOutcomeUnknown=true;
      }
      if(/\trejected\t(?:cursor_snapshot_failed|foreground_lost_before_click|click_target_not_foreground|focus_or_pointer_changed_before_down|activation_failed|expired_after_activation|expired_or_excessive_deadline|expired_before_message|window_size_changed|coordinate_out_of_bounds|target_window_not_unique|target_window_closed|target_window_minimized|background_message_failed:\d+|background_control_click_failed:[^\r\n]+|virtual_pointer_failed:[^\r\n]+|virtual_pointer_helper_missing|invalid_field_count|invalid_sequence_fields|invalid_or_duplicate_id|unsupported_action|unhandled_worker_error:[^\r\n]+)$/.test(error.message)){
        error.inputNotSent=true;
        if(this.call)this.call.uncertain=false;
      }
      throw error;
    }
    // Reject all captures begun before this input completed, including animation frames.
    this.inputCompletedMono=performance.now();
    appendEvidence(join(GAME.runtimeRoot??ROOT,'queue','input-actions.jsonl'),JSON.stringify({at:new Date().toISOString(),
      observationId:observation.id,capturedAt:observation.capturedAt,center,id:req.id,action:req.action,ack,
      ...((observation.terminal_phase?.name==='match_end'||observation.terminal_phase?.advance_confirm)?{
        endPage:observation.terminal_phase.page??'unknown',
        visibleEndControls:Object.keys(observation.terminal_phase.controls??{}),
        rematchSource:observation.terminal_phase.rematchSource??null
      }:{})})+'\n');
    if(!ack||ack.split('\t')[1]!=='input_sent')throw Error(`AHK input unconfirmed: ${ack??'missing acknowledgement'}`);
    // The caller must observe the river and hand after animation, then confirm
    // the bot session. An input receipt never commits a game event by itself.
    return {id:req.id,ack,gameConfirmed:false};
  }
  async decideAndDiscard(session,event,observation=this.latest){
    if(session.pending||this.call)throw Error('Previous action still pending');
    if(observation!==this.latest||!observation?.hand.complete)throw Error('Input observation unavailable');
    if(!this.points)throw Error('Opening point checkpoint required');
    const round=observation.round;
    if(!round?.seat_identity?.verified||!Number.isInteger(round.wind)||!Number.isInteger(round.hand_number?.value)||
       !Number.isInteger(round.remaining?.value)||!Number.isInteger(round.counters?.honba)||!Number.isInteger(round.counters?.riichi_sticks)||
       GAME.positions.some(p=>!observation.rivers?.[p]?.complete))
      throw Error('Complete public anchor required before initial discard');
    const points=this.points.botSnapshot(observation.id);
    session.context={...session.context,scores:points.scores,riichi_sticks:points.riichi_sticks,point_source:points.source};
    session.discardObservation=observation;
    session.opponentHandConstraints=observation.opponent_hand_constraints;
    const decision=await session.decide(event,observation.hand.tiles.map(t=>t.tile));
    decision.observationId=observation.id;
    return {decision,receipt:await this.discard(decision,observation)};
  }
  async decideAndExecute(session,event,observation=this.latest,publicState){
    if(observation!==this.latest||!observation?.hand.complete)throw Error('Input observation unavailable');
    if(session.pending||this.call)throw Error('Previous action still pending');
    if(!this.points)throw Error('Opening point checkpoint required');
    const positions=GAME.positions;
    if(positions.some(p=>this.pointSeats[p]!==publicState?.seats?.[p])){
      if(session.requests.length!==2)throw Error('Seat change requires a new hand session');
      const permutation=[];
      for(const p of positions)permutation[this.pointSeats[p]]=publicState.seats[p];
      this.points.rebaseSeats(permutation);this.pointSeats={...publicState.seats};
    }
    const context=visibleContext(observation,{...publicState,points:this.points.botSnapshot(observation.id)});
    if(publicState.seats.self!==session.seat)throw Error('Session seat differs from visible seat');
    session.context=context;
    session.discardObservation=observation;
    session.opponentHandConstraints=observation.opponent_hand_constraints;
    const decision=await session.decide(visibleActions(observation,event,publicState.melds),observation.hand.tiles.map(t=>t.tile));
    decision.observationId=observation.id;
    return {decision,receipt:await this.execute(decision,observation,publicState)};
  }
}
