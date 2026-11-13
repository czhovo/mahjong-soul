import {spawn} from 'node:child_process';
export function engineExchange(executable,input,{signal,args=['--analyze'],onPhaseStart,onPhaseEnd}={}){
 return new Promise((resolve,reject)=>{
  const child=spawn(executable,args,{windowsHide:true,stdio:['pipe','pipe','pipe'],signal});
  let buffer='',stdout='',stderr='',first=false,closed=false,cancelled=false;
  let active=false;
  const begin=()=>{if(!active){active=true;onPhaseStart?.();}};
  const end=()=>{if(active){active=false;onPhaseEnd?.();}};
  begin();
  const state={id:input.call_search.id,revision:0,status:'searching',result:null,error:null};
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
