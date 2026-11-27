import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';

export function engineExchange(executable,input,{signal,args=['--analyze'],onPhaseStart,onPhaseEnd}={}){
 return new Promise((resolve,reject)=>{
  const child=spawn(executable,args,{windowsHide:true,stdio:['pipe','pipe','pipe'],signal});
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let buffer='',stdout='',stderr='',first=false,closed=false,cancelled=false;
  let active=false;
  const begin=()=>{if(!active){active=true;onPhaseStart?.();}};
  const end=()=>{if(active){active=false;onPhaseEnd?.();}};
  begin();
  const state={id:input.call_search?.id??null,revision:0,status:'searching',result:null,error:null};
  const fail=error=>{end();state.status='failed';state.error=error.message;if(!first)reject(error);};
  const send=message=>{if(closed||cancelled)throw Error('Call search process is no longer available');child.stdin.write(JSON.stringify({schema:1,id:state.id,revision:state.revision,...message})+'\n');};
  const api={state,confirmCall:evidence=>send({type:'call_observed',...evidence}),
   correct:evidence=>{if(closed)throw Error('Engine exited before actual call was confirmed');begin();state.revision++;state.phaseStartedAt=Date.now();state.status='searching';state.result=null;send({type:'call_corrected',...evidence});},
   cancel:()=>{if(cancelled)return;cancelled=true;end();state.status='cancelled';if(!closed){child.stdin.end();child.kill();}}};
  Object.defineProperty(api,'stderr',{get:()=>stderr});
  function line(text){
   let msg;try{msg=JSON.parse(text);}catch{return;}
   if(!msg.phase){if(!first&&typeof msg.response==='string'&&!child.stdin.writableEnded)child.stdin.end();return;}
   if(msg.id!==state.id)return;
   if(msg.phase==='call'){
    if(first)return;
    if(msg.revision!==0||! /^(CHI|PENG) (?:[WBT][0-9]|Z[1-7]) (?:[WBT][0-9]|Z[1-7]) (?:[WBT][0-9]|Z[1-7])$/.test(msg.response??'')){fail(Error('Invalid staged call response'));api.cancel();return;}
    end();begin();first=true;state.phaseStartedAt=Date.now();resolve({output:msg,stderr,callSearch:api});
   }else if(msg.phase==='discard'&&first&&msg.revision===state.revision){
    if(!/^PLAY (?:[WBT][0-9]|Z[1-7])$/.test(msg.response??'')){fail(Error('Invalid staged discard response'));return;}
    state.result={...msg,elapsed_ms:Number.isFinite(msg.elapsed_ms)?msg.elapsed_ms:Date.now()-state.phaseStartedAt};state.status='ready';end();
   }else if(msg.phase==='error'&&msg.revision===state.revision)fail(Error(msg.error??'Call search failed'));
  }
  child.stdout.on('data',b=>{stdout+=b;buffer+=b;let i;while((i=buffer.indexOf('\n'))>=0){line(buffer.slice(0,i));buffer=buffer.slice(i+1);}});
  child.stderr.on('data',b=>stderr+=b);
  child.on('error',fail);child.stdin.on('error',error=>{if(!cancelled&&!closed)fail(error);});
  child.on('close',code=>{
   closed=true;end();if(cancelled)return;
   if(first){if(state.status!=='ready')fail(Error(`Call search exited before discard: ${code}`));return;}
   try{
    if(code!==0)throw Error(`Bot exit ${code}: ${stderr}`);
    const failure=stderr.split(/\r?\n/).find(l=>/^exception:/.test(l));if(failure)throw Error(failure);
    resolve({output:JSON.parse(stdout.trim().split('\n').at(-1)),stderr,callSearch:null});
   }catch(e){fail(e);}
  });
  child.stdin.write(JSON.stringify(input)+'\n');
 });
}

function makeAbortError(message='Engine request aborted'){
 return Object.assign(new Error(message),{name:'AbortError'});
}

// Persistent single-engine JSON Lines client (Stage 1 + Stage 2: cross-turn cache reuse,
// real-time incremental event stream, background pondering, and lossless reconnect recovery).
// Supports single-phase requests, Stage 2 stream RPCs (hand_start/event_push/hand_correct/
// state_sync/decide/cancel/hand_end/state_inspect), two-phase call_search (with non-destructive
// call_cancel), ping/session_reset, immediate AbortSignal kill, and lossless crash recovery.
export class PersistentEngineClient {
 constructor(executable,{args=['--analyze'],controlTimeoutMs=2000}={}){
  this.executable=executable;
  this.args=[...args];
  this.controlTimeoutMs=controlTimeoutMs;
  this.child=null;
  this.buffer='';
  this.requestStderr='';
  this.activeRequest=null;
  this.activeStaged=null;
  this.pendingControl=null;
  this.streamHandId=null;
  this.queue=Promise.resolve();
  this.closed=false;
  this.stats={spawns:0,requests:0,reusedRequests:0,resets:0,recoveries:0,streamHandStarts:0,streamEventsPushed:0,streamSyncs:0,streamDecides:0,streamHandEnds:0};
 }

 get alive(){
  return !!(this.child&&!this.child.killed&&this.child.exitCode===null&&this.child.stdin&&!this.child.stdin.destroyed&&!this.child.stdin.writableEnded);
 }

 _spawn(){
  if(this.alive)return false;
  this._teardown(true);
  const child=spawn(this.executable,this.args,{windowsHide:true,stdio:['pipe','pipe','pipe']});
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  this.child=child;
  this.buffer='';
  this.requestStderr='';
  this.streamHandId=null;
  this.stats.spawns++;
  child.stdout.on('data',chunk=>{
   if(this.child!==child)return;
   this.buffer+=chunk;
   let i;
   while((i=this.buffer.indexOf('\n'))>=0){
    const raw=this.buffer.slice(0,i).trim();
    this.buffer=this.buffer.slice(i+1);
    if(raw)this._onStdoutLine(raw);
   }
  });
  child.stderr.on('data',chunk=>{
   if(this.child!==child)return;
   this.requestStderr+=chunk;
   if(this.activeStaged)this.activeStaged.stderr+=chunk;
  });
  child.stdin.on('error',error=>{
   if(this.child!==child)return;
   this._failAll(error);
  });
  child.on('error',error=>{
   if(this.child!==child)return;
   this._failAll(error);
  });
  child.on('close',code=>{
   if(this.child!==child)return;
   this.child=null;
   const fatal=code===4||/fatal_request_error|fatal:/i.test(this.requestStderr);
   const err=Object.assign(new Error(`Bot exit ${code}: ${this.requestStderr.slice(-1000)}`),{exitCode:code,fatal});
   this._failAll(err);
  });
  return true;
 }

 _failAll(error){
  if(this.pendingControl){
   const ctrl=this.pendingControl;this.pendingControl=null;
   clearTimeout(ctrl.timer);
   ctrl.reject(error);
  }
  if(this.activeRequest){
   const req=this.activeRequest;this.activeRequest=null;
   req.cleanup?.();
   req.end?.();
   req.reject(error);
  }
  if(this.activeStaged){
   const st=this.activeStaged;this.activeStaged=null;
   st.end?.();
   if(st.state.status==='searching'){st.state.status='failed';st.state.error=error.message;}
   st.onCancelDone?.();
  }
 }

 _teardown(force=false){
  const child=this.child;
  this.child=null;
  this.buffer='';
  this.streamHandId=null;
  if(!child)return;
  try{if(!child.stdin.destroyed&&!child.stdin.writableEnded)child.stdin.end();}catch{}
  if(force){
   try{child.kill();}catch{}
  }
 }

 _writeJson(obj){
  if(!this.alive)throw new Error('Persistent engine process is not available');
  this.child.stdin.write(JSON.stringify(obj)+'\n');
 }

 _onStdoutLine(text){
  let msg;
  try{msg=JSON.parse(text);}catch{return;}
  if(this.pendingControl&&msg.type===this.pendingControl.expectedType){
   const ctrl=this.pendingControl;this.pendingControl=null;
   clearTimeout(ctrl.timer);
   if(msg.ok===false)ctrl.reject(new Error(msg.error||`Control message failed: ${msg.type}`));
   else ctrl.resolve(msg);
   return;
  }
  if(msg.type==='call_cancel_ack'){
   if(this.activeStaged&&(!msg.id||msg.id===this.activeStaged.state.id)){
    const st=this.activeStaged;this.activeStaged=null;
    st.end?.();
    st.onCancelDone?.();
   }
   return;
  }
  if(msg.type==='cancel_ack'){
   return;
  }
  if(this.activeStaged&&msg.phase&&msg.id===this.activeStaged.state.id){
   const st=this.activeStaged;
   if(msg.phase==='discard'&&msg.revision===st.state.revision){
    if(!/^PLAY (?:[WBT][0-9]|Z[1-7])$/.test(msg.response??'')){
     st.end?.();st.state.status='failed';st.state.error='Invalid staged discard response';return;
    }
    st.state.result={...msg,elapsed_ms:Number.isFinite(msg.elapsed_ms)?msg.elapsed_ms:Date.now()-st.state.phaseStartedAt};
    st.state.status='ready';
    st.end?.();
   }else if(msg.phase==='error'&&msg.revision===st.state.revision){
    st.end?.();st.state.status='failed';st.state.error=msg.error??'Call search failed';
   }
   return;
  }
  if(!this.activeRequest)return;
  const req=this.activeRequest;
  if(msg.phase==='call'){
   if(msg.id!==req.callId)return;
   if(msg.revision!==0||!/^(CHI|PENG) (?:[WBT][0-9]|Z[1-7]) (?:[WBT][0-9]|Z[1-7]) (?:[WBT][0-9]|Z[1-7])$/.test(msg.response??'')){
    this.activeRequest=null;req.cleanup?.();req.end?.();
    this._teardown(true);
    req.reject(new Error('Invalid staged call response'));
    return;
   }
   this.activeRequest=null;
   req.cleanup?.();
   req.end?.();
   req.begin?.();
   const state={id:req.callId,revision:0,status:'searching',result:null,error:null,phaseStartedAt:Date.now()};
   const staged={state,stderr:this.requestStderr,begin:req.begin,end:req.end,cancelPromise:null,onCancelDone:null};
   this.activeStaged=staged;
   const sendStaged=message=>{
    if(this.activeStaged!==staged||!this.alive||state.status==='cancelled')
     throw new Error('Call search process is no longer available');
    this._writeJson({schema:1,id:state.id,revision:state.revision,...message});
   };
   const api={
    state,
    confirmCall:evidence=>sendStaged({type:'call_observed',...evidence}),
    correct:evidence=>{
     if(this.activeStaged!==staged||!this.alive)throw new Error('Engine exited before actual call was confirmed');
     req.begin?.();state.revision++;state.phaseStartedAt=Date.now();state.status='searching';state.result=null;
     sendStaged({type:'call_corrected',...evidence});
    },
    cancel:()=>{
     if(state.status==='cancelled')return;
     state.status='cancelled';
     req.end?.();
     if(this.activeStaged!==staged)return;
     if(!this.alive){this.activeStaged=null;return;}
     staged.cancelPromise=new Promise(resolveDone=>{
      const timer=setTimeout(()=>{
       if(this.activeStaged===staged){this.activeStaged=null;this._teardown(true);}
       resolveDone();
      },this.controlTimeoutMs);
      staged.onCancelDone=()=>{clearTimeout(timer);resolveDone();};
     });
     try{this._writeJson({schema:1,type:'call_cancel',id:state.id});}
     catch{if(this.activeStaged===staged){this.activeStaged=null;this._teardown(true);}staged.onCancelDone?.();}
    },
   };
   Object.defineProperty(api,'stderr',{get:()=>staged.stderr});
   req.resolve({output:msg,stderr:this.requestStderr,callSearch:api});
   return;
  }
  if(!msg.phase&&typeof msg.response==='string'){
   const stderr=this.requestStderr;
   const failure=stderr.split(/\r?\n/).find(l=>/^exception:/.test(l));
   this.activeRequest=null;
   req.cleanup?.();
   req.end?.();
   if(failure)req.reject(new Error(failure));
   else req.resolve({output:msg,stderr,callSearch:null});
  }
 }

 async _ensureNoActiveStaged(){
  if(!this.activeStaged)return;
  const st=this.activeStaged;
  if(st.cancelPromise){await st.cancelPromise;return;}
  if(this.alive){
   await new Promise(resolveDone=>{
    const timer=setTimeout(()=>{
     if(this.activeStaged===st){this.activeStaged=null;this._teardown(true);}
     resolveDone();
    },this.controlTimeoutMs);
    st.onCancelDone=()=>{clearTimeout(timer);resolveDone();};
    try{this._writeJson({schema:1,type:'call_cancel',id:st.state.id});}
    catch{clearTimeout(timer);if(this.activeStaged===st)this.activeStaged=null;this._teardown(true);resolveDone();}
   });
  }else{
   this.activeStaged=null;
  }
 }

 async _sendControl(payload,expectedType){
  if(!this.alive)return null;
  await this._ensureNoActiveStaged();
  if(!this.alive)return null;
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{
    if(this.pendingControl?.expectedType===expectedType)this.pendingControl=null;
    this._teardown(true);
    reject(new Error(`Control message timeout: ${payload.type}`));
   },this.controlTimeoutMs);
   this.pendingControl={expectedType,resolve,reject,timer};
   try{this._writeJson(payload);}
   catch(error){
    clearTimeout(timer);
    if(this.pendingControl?.expectedType===expectedType)this.pendingControl=null;
    reject(error);
   }
  });
 }

 _enqueue(fn){
  const run=this.queue.then(fn,fn);
  this.queue=run.then(()=>{},()=>{});
  return run;
 }

 async ping(){
  return this._enqueue(async()=>{
   if(this.closed)throw new Error('Persistent engine client is closed');
   this._spawn();
   return this._sendControl({schema:1,type:'ping',id:randomUUID()},'pong');
  });
 }

 async resetSession({reason='new_hand',clearAll=true}={}){
  return this._enqueue(async()=>{
   if(this.closed||!this.alive)return null;
   try{
    const ack=await this._sendControl({schema:1,type:'session_reset',reason,clear_all:true},'session_reset_ack');
    this.streamHandId=null;
    this.stats.resets++;
    return ack;
   }catch{
    this._teardown(true);
    return null;
   }
  });
 }

 async handStart({handId,seq=1,requests,seat,round=0,hand,doraIndicators,remaining,matchContext,opponentHandConstraints,ponder=true,ponderSeconds=1.2}={}){
  return this._enqueue(async()=>{
   if(this.closed)return null;
   try{
    this._spawn();
    const payload={schema:1,type:'hand_start',hand_id:handId,seq,ponder,ponder_seconds:ponderSeconds};
    if(Array.isArray(requests)&&requests.length)payload.requests=requests;
    else{
     payload.seat=seat;payload.round=round;
     if(Array.isArray(hand))payload.hand=hand;
    }
    if(typeof doraIndicators==='string'&&doraIndicators)payload.dora_indicators=doraIndicators;
    if(Number.isInteger(remaining))payload.remaining=remaining;
    if(matchContext)payload.match_context=matchContext;
    if(opponentHandConstraints)payload.opponent_hand_constraints=opponentHandConstraints;
    const ack=await this._sendControl(payload,'hand_start_ack');
    this.streamHandId=handId;
    this.stats.streamHandStarts++;
    return ack;
   }catch{
    this._teardown(true);
    return null;
   }
  });
 }

 async pushEvents({handId,seq,events=[],doraIndicators,remaining,matchContext,opponentHandConstraints,ponder=true,ponderSeconds=1.2}={}){
  return this._enqueue(async()=>{
   if(this.closed||!this.alive||this.streamHandId!==handId)return null;
   try{
    const payload={schema:1,type:'event_push',hand_id:handId,seq,events,ponder,ponder_seconds:ponderSeconds};
    if(typeof doraIndicators==='string'&&doraIndicators)payload.dora_indicators=doraIndicators;
    if(Number.isInteger(remaining))payload.remaining=remaining;
    if(matchContext)payload.match_context=matchContext;
    if(opponentHandConstraints)payload.opponent_hand_constraints=opponentHandConstraints;
    const ack=await this._sendControl(payload,'event_ack');
    this.stats.streamEventsPushed+=events.length;
    return ack;
   }catch{
    this._teardown(true);
    return null;
   }
  });
 }

 async correctHand({handId,seq,hand,ponder=true,ponderSeconds=1.2}={}){
  return this._enqueue(async()=>{
   if(this.closed||!this.alive||this.streamHandId!==handId)return null;
   try{
    return await this._sendControl({schema:1,type:'hand_correct',hand_id:handId,seq,hand,ponder,ponder_seconds:ponderSeconds},'hand_correct_ack');
   }catch{
    this._teardown(true);
    return null;
   }
  });
 }

 async syncState({handId,seq=0,requests,remaining,matchContext,opponentHandConstraints,ponder=true,ponderSeconds=1.2}={}){
  return this._enqueue(async()=>{
   if(this.closed)return null;
   try{
    this._spawn();
    const payload={schema:1,type:'state_sync',hand_id:handId,seq,requests,ponder,ponder_seconds:ponderSeconds};
    if(Number.isInteger(remaining))payload.remaining=remaining;
    if(matchContext)payload.match_context=matchContext;
    if(opponentHandConstraints)payload.opponent_hand_constraints=opponentHandConstraints;
    const ack=await this._sendControl(payload,'state_sync_ack');
    this.streamHandId=handId;
    this.stats.streamSyncs++;
    return ack;
   }catch{
    this._teardown(true);
    return null;
   }
  });
 }

 async inspectState(){
  return this._enqueue(async()=>{
   if(this.closed||!this.alive)return null;
   return this._sendControl({schema:1,type:'state_inspect'},'state_inspect_ack');
  });
 }

 async handEnd({reason='hand_end'}={}){
  return this._enqueue(async()=>{
   if(this.closed||!this.alive){this.streamHandId=null;return null;}
   try{
    const ack=await this._sendControl({schema:1,type:'hand_end',reason},'hand_end_ack');
    this.streamHandId=null;
    this.stats.streamHandEnds++;
    return ack;
   }catch{
    this._teardown(true);
    return null;
   }
  });
 }

 cancelRequest(requestId){
  if(!this.alive)return false;
  try{this._writeJson({schema:1,type:'cancel',request_id:requestId??''});return true;}
  catch{return false;}
 }

 async decideStream({handId,seq=0,prefixRequests=null,event=null,reuseObserved=false,matchContext=null,opponentHandConstraints=null,callSearch=null,fallbackRequests=null},{signal,onPhaseStart,onPhaseEnd}={}){
  return this._enqueue(async()=>{
   if(this.closed)throw new Error('Persistent engine client is closed');
   if(signal?.aborted)throw makeAbortError();
   const attempt=async()=>{
    await this._ensureNoActiveStaged();
    const spawnedFresh=this._spawn();
    if((spawnedFresh||this.streamHandId!==handId)&&Array.isArray(prefixRequests)&&prefixRequests.length){
     const syncPayload={schema:1,type:'state_sync',hand_id:handId,seq,requests:prefixRequests,ponder:false};
     if(matchContext)syncPayload.match_context=matchContext;
     if(opponentHandConstraints)syncPayload.opponent_hand_constraints=opponentHandConstraints;
     await this._sendControl(syncPayload,'state_sync_ack');
     this.streamHandId=handId;
     this.stats.streamSyncs++;
    }
    this.stats.requests++;
    this.stats.streamDecides++;
    if(!spawnedFresh)this.stats.reusedRequests++;
    this.requestStderr='';
    const reqId=randomUUID();
    const payload={schema:1,type:'decide',hand_id:handId,request_id:reqId,reuse_observed:reuseObserved};
    if(event)payload.event=event;
    if(matchContext)payload.match_context=matchContext;
    if(opponentHandConstraints)payload.opponent_hand_constraints=opponentHandConstraints;
    if(callSearch)payload.call_search=callSearch;
    if(this.streamHandId!==handId&&Array.isArray(fallbackRequests))payload.requests=fallbackRequests;
    return new Promise((resolve,reject)=>{
     let active=false;
     const begin=()=>{if(!active){active=true;onPhaseStart?.();}};
     const end=()=>{if(active){active=false;onPhaseEnd?.();}};
     const onAbort=()=>{
      if(this.activeRequest?.reject===reject)this.activeRequest=null;
      cleanup();
      end();
      this._teardown(true);
      reject(makeAbortError());
     };
     const cleanup=()=>{signal?.removeEventListener?.('abort',onAbort);};
     if(signal){
      if(signal.aborted){onAbort();return;}
      signal.addEventListener('abort',onAbort,{once:true});
     }
     begin();
     this.activeRequest={callId:callSearch?.id??null,resolve,reject,begin,end,cleanup};
     try{this._writeJson(payload);}
     catch(error){
      if(this.activeRequest?.reject===reject)this.activeRequest=null;
      cleanup();end();reject(error);
     }
    });
   };
   try{
    return await attempt();
   }catch(error){
    if(error.name==='AbortError'||signal?.aborted||error.fatal)throw error;
    this._teardown(true);
    this.stats.recoveries++;
    return attempt();
   }
  });
 }

 async exchange(input,{signal,onPhaseStart,onPhaseEnd}={}){
  return this._enqueue(async()=>{
   if(this.closed)throw new Error('Persistent engine client is closed');
   if(signal?.aborted)throw makeAbortError();
   const attempt=async()=>{
    await this._ensureNoActiveStaged();
    const spawnedFresh=this._spawn();
    this.stats.requests++;
    if(!spawnedFresh)this.stats.reusedRequests++;
    this.requestStderr='';
    return new Promise((resolve,reject)=>{
     let active=false;
     const begin=()=>{if(!active){active=true;onPhaseStart?.();}};
     const end=()=>{if(active){active=false;onPhaseEnd?.();}};
     const onAbort=()=>{
      if(this.activeRequest?.reject===reject)this.activeRequest=null;
      cleanup();
      end();
      this._teardown(true);
      reject(makeAbortError());
     };
     const cleanup=()=>{signal?.removeEventListener?.('abort',onAbort);};
     if(signal){
      if(signal.aborted){onAbort();return;}
      signal.addEventListener('abort',onAbort,{once:true});
     }
     begin();
     this.activeRequest={callId:input.call_search?.id??null,resolve,reject,begin,end,cleanup};
     try{this._writeJson(input);}
     catch(error){
      if(this.activeRequest?.reject===reject)this.activeRequest=null;
      cleanup();end();reject(error);
     }
    });
   };
   try{
    return await attempt();
   }catch(error){
    if(error.name==='AbortError'||signal?.aborted||error.fatal)throw error;
    // Crash or broken-pipe recovery: discard dead process and retry once on a clean cold spawn.
    this._teardown(true);
    this.stats.recoveries++;
    return attempt();
   }
  });
 }

 async close({force=false}={}){
  this.closed=true;
  const child=this.child;
  if(!child){this._failAll(makeAbortError('Engine client closed'));return;}
  if(force){
   this._teardown(true);
   this._failAll(makeAbortError('Engine client force-closed'));
   return;
  }
  await new Promise(resolve=>{
   const timer=setTimeout(()=>{try{child.kill();}catch{}resolve();},400);
   child.once('close',()=>{clearTimeout(timer);resolve();});
   this._teardown(false);
  });
 }
}

export class PersistentEnginePool {
 constructor({args=['--analyze'],controlTimeoutMs=2000}={}){
  this.args=args;
  this.controlTimeoutMs=controlTimeoutMs;
  this.clients=new Map();
  this.closed=false;
  this._onProcessExit=()=>{
   for(const client of this.clients.values()){
    try{client._teardown(true);}catch{}
   }
   this.clients.clear();
  };
  process.once('exit',this._onProcessExit);
 }

 getClient(executable){
  let client=this.clients.get(executable);
  if(!client||client.closed){
   client=new PersistentEngineClient(executable,{args:this.args,controlTimeoutMs:this.controlTimeoutMs});
   this.clients.set(executable,client);
  }
  return client;
 }

 async exchange(executable,input,options={}){
  if(this.closed)return engineExchange(executable,input,options);
  return this.getClient(executable).exchange(input,options);
 }

 async handStart(executable,params={}){
  if(this.closed)return null;
  return this.getClient(executable).handStart(params);
 }

 async pushEvents(executable,params={}){
  if(this.closed)return null;
  return this.getClient(executable).pushEvents(params);
 }

 async correctHand(executable,params={}){
  if(this.closed)return null;
  return this.getClient(executable).correctHand(params);
 }

 async syncState(executable,params={}){
  if(this.closed)return null;
  return this.getClient(executable).syncState(params);
 }

 async inspectState(executable){
  if(this.closed)return null;
  return this.getClient(executable).inspectState();
 }

 async decideStream(executable,params,options={}){
  if(this.closed){
   const fallbackInput={requests:params.fallbackRequests??[...(params.prefixRequests??[]),...(params.event?[params.event]:[])],match_context:params.matchContext,call_search:params.callSearch,...(params.opponentHandConstraints?{opponent_hand_constraints:params.opponentHandConstraints}:{})};
   return engineExchange(executable,fallbackInput,options);
  }
  return this.getClient(executable).decideStream(params,options);
 }

 async handEnd(options={}){
  const jobs=[];
  for(const client of this.clients.values()){
   if(client.alive)jobs.push(client.handEnd(options));
  }
  await Promise.allSettled(jobs);
 }

 async resetSession(options={}){
  const jobs=[];
  for(const client of this.clients.values()){
   if(client.alive)jobs.push(client.resetSession(options));
  }
  await Promise.allSettled(jobs);
 }

 async closeAll({force=false}={}){
  this.closed=true;
  process.removeListener('exit',this._onProcessExit);
  const clients=[...this.clients.values()];
  this.clients.clear();
  await Promise.allSettled(clients.map(c=>c.close({force})));
 }
}
