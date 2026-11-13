import {DEFAULT_PYTHON} from './runtime-paths.mjs';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {GAME} from './game-rules.mjs';
import {focusGame} from './focus-game.mjs';
import {deliverModalText} from './modal-text-results.mjs';
import {setTimeout as delay} from 'node:timers/promises';
const ROOT=dirname(fileURLToPath(import.meta.url));
export class NativeCapture {
 constructor(window,{python=DEFAULT_PYTHON,transientPath=null,saveAllScreenshots=false}={}){
  if(!window?.id||!['雀魂麻將','雀魂麻将'].includes(window.title))throw Error('Previously selected game window required');
  this.transientPath=transientPath;
  this.saveAllScreenshots=saveAllScreenshots;
  this.archiveDirectory=saveAllScreenshots?join(GAME.runtimeRoot??ROOT,'saved-debug-screenshots',new Date().toISOString().replaceAll(':','-')+'-'+randomUUID()):null;
  this.window=window;this.requests=new Map();this.modalTextIds=new Set();
  this.ready=new Promise((resolve,reject)=>{this.resolveReady=resolve;this.rejectReady=reject;});this.ready.catch(()=>{});
  this.worker=spawn(python,['-u','-X','utf8',join(ROOT,'capture-worker.py')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let buffer='';this.stderr='';
  this.worker.stderr.on('data',b=>this.stderr+=b);
  this.worker.stdout.on('data',b=>{buffer+=b;let n;while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);try{
   const r=JSON.parse(line);if(r.type==='ready'){this.resolveReady();continue;}
   if(r.type==='modal_text'){deliverModalText(r.id,r.result);this.modalTextIds.delete(r.id);continue;}
   if(r.modalConfirm?.modalTextId)this.modalTextIds.add(r.modalConfirm.modalTextId);
   const pending=this.requests.get(r.id);if(pending){clearTimeout(pending.timer);this.requests.delete(r.id);r.error?pending.reject(Error(r.error)):pending.resolve(r);}
  }catch(error){this.fail(error);}}});
  this.worker.on('error',error=>this.fail(error));
  this.worker.on('exit',code=>this.fail(Error(`Capture worker exited ${code}: ${this.stderr.slice(-500)}`)));
 }
 fail(error){this.error=error;this.rejectReady(error);for(const p of this.requests.values()){clearTimeout(p.timer);p.reject(error);}this.requests.clear();for(const id of this.modalTextIds)deliverModalText(id,{});this.modalTextIds.clear();}
 async capture(retryFocus=true,readReserve=false){
  for(;;){
   try{return await this.captureOnce(retryFocus,readReserve);}
   catch(error){
    if(!/^(?:Game moved or lost focus during capture|WGC window resized; acquire latest frame|WGC client geometry changed; acquire latest frame)$/.test(error.message)||this.closing)throw error;
    // Reject only the torn frame. The next request reads the new window
    // bounds; keep this worker and the caller's decision state alive.
    await delay(25);
   }
  }
 }
 async captureOnce(retryFocus=true,readReserve=false){
  await this.ready;if(this.error)throw this.error;
  const id=randomUUID(),path=this.archiveDirectory?join(this.archiveDirectory,id+'.mjc'):this.transientPath??join(GAME.runtimeRoot??ROOT,'test-evidence/native-archive',id+'.mjc');
  let result;
  try{result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.requests.delete(id);reject(Error('Native capture timeout'));},5000);this.requests.set(id,{resolve,reject,timer});this.worker.stdin.write(JSON.stringify({id,path,hwnd:this.window.id,readReserve,saveAllScreenshots:this.saveAllScreenshots})+'\n');});}
  catch(error){
   if(error.message==='Native capture timeout'){
    // A timed-out request may still block the single worker. Do not queue
    // more captures behind it; let the resident recreate capture and binding.
    this.fail(Error('Capture worker stalled; rediscovery required'));
    this.worker.kill();throw this.error;
   }
   if(retryFocus&&/Bound game must (?:be foreground and not|not be) minimized/.test(error.message)){
    try{await focusGame(this.window);}catch{throw error;}
    return this.capture(false,readReserve);
   }
   throw error;
  }
  this.last=result;
  return {window:this.window,screenshots:[{id,width:result.width,height:result.height,path:result.path}],captureEvidence:result};
 }
 close(){
  if(this.closing)return this.closing;
  if(this.worker.exitCode!==null)return Promise.resolve();
  // EOF lets the capture worker flush queued debug screenshots before exit.
  this.closing=new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{this.worker.kill();reject(Error('Capture archive flush timed out; queued screenshots may be incomplete'));},10000);
   this.worker.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error(`Capture archive flush failed: ${this.stderr.slice(-500)}`));});
   this.worker.stdin.end();
  });
  return this.closing;
 }
}
