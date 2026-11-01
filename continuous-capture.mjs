import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {appendEvidence,flushEvidence} from './background-evidence.mjs';

// One owner of window capture. Recognition and bot calculation may consume
// the latest frame while intervening visible frames continue to be archived.
export class ContinuousCapture {
 constructor(capture,directory){this.capture=capture;this.directory=directory;this.count=0;this.latest=null;this.running=false;this.waiters=[];}
 start({durationMs=60000,intervalMs=100,frozenAfterMs=60000,centralStillMs=2000,centralRetryMs=1000,onCentralStill=null,onCaptureState=null,onPriorityFrame=null}={}){
  if(this.running)throw Error('Capture already running');
  this.running=true;this.error=null;this.frozenAfterMs=frozenAfterMs;this.lastPixelChange=null;
  this.centralRetryMs=centralRetryMs;this.centralLastAttempt=-Infinity;this.centralState=null;this.centralStillMs=centralStillMs;this.onCentralStill=onCentralStill;this.centralSignature=null;this.centralTriggered=false;this.lastStallAt=null;
  this.onCaptureState=onCaptureState;
  this.onPriorityFrame=onPriorityFrame;
  this.done=this.run(durationMs,intervalMs).catch(error=>{this.error=error;throw error;}).finally(()=>{this.running=false;for(const w of this.waiters.splice(0))w();});
  // The owner can inspect done/error without an unhandled rejection.
  this.done.catch(()=>{});return this;
 }
 async run(durationMs,intervalMs){
  await mkdir(this.directory,{recursive:true});const end=performance.now()+durationMs;
  while(this.running&&performance.now()<end){
   const started=performance.now();let state;
   try{state=await this.capture();}
   catch(error){
    if(!/Bound game must be foreground and not minimized|Native capture timeout/.test(error.message))throw error;
    // Foreground loss is temporary. Invalidate stale pixels, wake consumers,
    // and keep the single capture owner alive until the window returns.
    if(!this.pausedError)await this.onCaptureState?.({kind:'capture_paused',reason:error.message});
    this.pausedError=error;this.latest=null;
    // Once recovery has started, missing captures do not count as recovery.
    if(this.centralTriggered)await this.recoverCentral(this.centralState,performance.now());
    else {this.centralSignature=null;this.centralTriggered=false;}
    for(const w of this.waiters.splice(0))w();
    await new Promise(r=>setTimeout(r,Math.max(10,intervalMs)));continue;
   }
   const capturedAt=Date.now(),capturedMono=performance.now();
   // Modal input is resolved before stall recovery and never published as a
   // playable/terminal frame. Only a subsequent capture can clear the modal.
   if(state.captureEvidence?.modalConfirm?.verified&&this.onPriorityFrame){
    this.latest=null;this.centralSignature=null;this.centralTriggered=false;this.lastPixelChange=capturedMono;
    await this.onPriorityFrame(state);
    continue;
   }
   if(this.pausedError)await this.onCaptureState?.({kind:'capture_resumed'});
   const signature=state.captureEvidence?.centralPixelSignature;
   if(!signature){this.centralSignature=null;this.centralTriggered=false;}
   else if(signature!==this.centralSignature){this.centralSignature=signature;this.centralChangedAt=capturedMono;this.centralTriggered=false;this.centralLastAttempt=-Infinity;}
   if(signature){this.centralState=state;await this.recoverCentral(state,capturedMono);}
   if(state.captureEvidence?.pixelsReused!==true||this.lastPixelChange===null)this.lastPixelChange=capturedMono;
   if(capturedMono-this.lastPixelChange>=this.frozenAfterMs){
    this.latest=null;
    throw Error('Frozen game image: pixels unchanged for 60 seconds; game restart required');
   }
   this.pausedError=null;
   const memory=state.captureEvidence?.frameMemory;
   const shot=state.screenshots?.[0];if(!shot?.path&&!shot?.url?.startsWith('data:image/')&&!memory)throw Error('Missing visible image');
   const id=randomUUID(),path=shot?.path??(memory?null:join(this.directory,id+'.png'));
   if(!shot?.path&&!memory)await writeFile(path,Buffer.from(shot.url.split(',')[1],'base64'));
   const stalled=!!signature&&capturedMono-this.centralChangedAt>=this.centralStillMs;
   if(stalled)this.lastStallAt=capturedAt;
   const entry={stalled,lastStallAt:this.lastStallAt,id,path,capturedAt,captureMs:capturedMono-started,sequence:++this.count,window:state.window,pixelsReused:state.captureEvidence?.pixelsReused===true,
    centralPixelSignature:signature??null,centralStableMs:signature?capturedMono-this.centralChangedAt:null,centralRecoveryTriggered:this.centralTriggered};
   appendEvidence(join(this.directory,'index.jsonl'),JSON.stringify(entry)+'\n');
   this.latest={...entry,state,capturedMono};for(const w of this.waiters.splice(0))w();
   const delay=intervalMs-(performance.now()-started);if(delay>0)await new Promise(r=>setTimeout(r,delay));
  }
  return {frames:this.count,directory:this.directory};
 }
 async recoverCentral(state,now){
  if(!state||!this.onCentralStill||now-this.centralChangedAt<this.centralStillMs||now-this.centralLastAttempt<this.centralRetryMs)return;
  this.centralLastAttempt=now;
  if(await this.onCentralStill(state,{since:this.centralChangedAt,stableForMs:now-this.centralChangedAt})!==false)this.centralTriggered=true;
 }
 async next(afterSequence=0,notBeforeMono=-Infinity){
  while(!this.latest||this.latest.sequence<=afterSequence||this.latest.capturedMono-this.latest.captureMs<notBeforeMono){
   if(this.error)throw this.error;if(!this.running)throw Error('Capture stopped');
   if(this.pausedError)throw this.pausedError;
   await new Promise(resolve=>this.waiters.push(resolve));
  }
  return this.latest;
 }
 async stop(){this.running=false;try{return await this.done;}finally{await flushEvidence();}}
}
