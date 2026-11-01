import {annotateDiscardRequests} from './discard-evidence.mjs';
import {appendEvidence} from './background-evidence.mjs';
import {verifyEngineBuild} from './engine-builds.mjs';
import {preserveRiichi} from './confirmed-riichi.mjs';
import {spawn} from 'node:child_process';
import {initialLedger,applyPublicEvent,assertVisibleHand} from './hand-ledger.mjs';
import {decisionMetrics} from './decision-metrics.mjs';
import {missingOpenKongs,currentIndicators} from './verified-public-input.mjs';

// Public observations only. The observer supplies ordered, verified game events.
export class TingfengSession {
  constructor(executable, evidenceDirectory) {
    this.executable=executable; this.directory=evidenceDirectory;
    this.requests=[]; this.responses=[]; this.pending=null;
  }
  begin({seat,round,hand,indicator,context}) {
    if(!Number.isInteger(seat)||seat<0||seat>3||hand.length!==13) throw Error('Invalid initial public state');
    if(typeof indicator!=='string'||!indicator.trim()||indicator.trim().split(/\s+/).some(t=>!/^(?:[WBT][0-9]|Z[1-7])$/.test(t)))throw Error('Dora indicators must use the frozen protocol string format');
    this.requests=[{state:`0 ${seat} ${round}`,validact:null},{handTiles:`1 ${hand.join(' ')}`,doraIndicators:indicator,validact:null}];
    this.responses=['PASS','PASS']; this.context=context; this.pending=null; this.seat=seat;
    this.ledger=initialLedger(seat,hand);
    this.opponentHandConstraints=undefined;
    this.currentDora=[];this.discardObservation=undefined;
  }
  observe(event) {
    if(this.pending)throw Error('Confirm or resolve pending action before recording another event');
    this.ledger=applyPublicEvent(this.ledger,event);
    this.requests.push(event); this.responses.push('PASS');
  }
  restoreSnapshot(snapshot){
    if(this.pending)throw Error('Cannot replace history with a pending mouse action');
    const restored=preserveRiichi(this.requests,snapshot.requests);
    this.currentDora=currentIndicators(this.requests,null,this.currentDora);
    this.requests=restored;this.responses=this.requests.map(()=> 'PASS');
    this.seat=snapshot.seat;this.ledger=initialLedger(snapshot.seat,snapshot.hand);
    // Restore the public discard anchor as well as the concealed hand.
    // Leaving lastPlayer null made reactionSpan reject every later frame.
    for(const request of this.requests){
      const w=request.state?.split(/\s+/)??[];
      if(w[0]!=='3')continue;
      const tile=['PLAY','LIZHI'].includes(w[2])?w[3]:['CHI','PENG'].includes(w[2])?w[6]:null;
      if(tile){this.ledger.lastPlayer=Number(w[1]);this.ledger.lastDiscard=tile;}
    }
    this.estimatedHistory={frameId:snapshot.frameId,assumptions:snapshot.assumptions};
  }
  observeVerified(transition,visibleHand) {
    if(this.pending)throw Error('Confirm pending action before recording a transition');
    if(!transition?.verified||!Array.isArray(transition.requests))throw Error('Unverified public transition');
    // Validate the entire batch before committing any request. A failed final
    // hand check must not leave an extra DRAW or half of a call in history.
    let ledger=structuredClone(this.ledger);
    for(const event of transition.requests)ledger=applyPublicEvent(ledger,event);
    assertVisibleHand(ledger,visibleHand);
    this.ledger=ledger;
    this.requests.push(...transition.requests);
    this.responses.push(...transition.requests.map(()=> 'PASS'));
  }
  reconcileVisibleHand(visible,{frameId}={}) {
    if(this.pending)throw Error('Resolve pending input before synchronizing current hand');
    if(!this.ledger||!Array.isArray(visible)||!visible.every(t=>/^(?:[WBT][0-9]|Z[1-7])$/.test(t)))throw Error('Invalid visible hand');
    if(JSON.stringify([...this.ledger.hand].sort())===JSON.stringify([...visible].sort()))return false;
    const request={handTiles:`1 ${visible.join(' ')}`,validact:null,source:'verified-current-hand',frameId};
    this.observeVerified({verified:true,requests:[request]},visible);
    return true;
  }
  async decide(event, visibleHand, {reuseObserved=false,signal}={}) {
    if(this.pending) throw Error('Previous action has not been verified in the client');
    if(reuseObserved&&(this.requests.at(-1)?.state!==event.state||this.responses.at(-1)!=='PASS'))
      throw Error('Late reaction must target the latest observed event');
    const nextLedger=reuseObserved?structuredClone(this.ledger):applyPublicEvent(this.ledger,event);
    assertVisibleHand(nextLedger,visibleHand);
    for(const {index,events} of missingOpenKongs(this.requests,this.discardObservation)){
      this.requests.splice(index,0,...events);this.responses.splice(index,0,...events.map(()=> 'PASS'));
    }
    this.currentDora=currentIndicators(this.requests,this.discardObservation,this.currentDora);
    if(this.currentDora.length)event={...event,doraIndicators:this.currentDora.join(' ')};
    const input={requests:[...(reuseObserved?this.requests.slice(0,-1):this.requests),event],responses:reuseObserved?this.responses.slice(0,-1):[...this.responses],data:null,match_context:this.context};
    input.requests=annotateDiscardRequests(input.requests,this.discardObservation);
    if(this.opponentHandConstraints?.schema===2)
      input.opponent_hand_constraints=structuredClone(this.opponentHandConstraints);
    const started=Date.now();
    let metrics;
    const searchSeconds=this.searchBudget?.seconds??3.3;
    let executable=this.executable;
    if(searchSeconds===1.7){
      this.verifiedBudgetEngine??=await verifyEngineBuild(this.executable);
      executable=this.verifiedBudgetEngine.reducedExecutable??this.executable;
    }
    const output=await new Promise((resolve,reject)=>{
      const child=spawn(executable,['--analyze'],{windowsHide:true,stdio:['pipe','pipe','pipe'],signal});
      let stdout='',stderr='';
      child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
      child.on('error',reject);
      child.on('close',code=>{if(code!==0)return reject(Error(`Bot exit ${code}: ${stderr}`));try{
        const failure=stderr.split(/\r?\n/).find(line=>/^exception:/.test(line));
        if(failure)throw Object.assign(Error(`Bot calculation failed: ${failure}`),{code:'BOT_INVALID_RESULT'});
        const result=JSON.parse(stdout.trim().split('\n').at(-1));
        const kind=result.response?.trim().split(/\s+/)[0];
        const allowed=(event.validact??'').split(',').map(x=>x.trim().split(/\s+/)[0]);
        if(kind==='PASS'&&!allowed.includes('PASS'))throw Object.assign(Error('Bot returned PASS outside a reaction window'),{code:'BOT_INVALID_RESULT'});
        metrics=decisionMetrics(stderr,result.response,input);resolve(result);
      }catch(e){reject(e)}});
      child.stdin.end(JSON.stringify(input)+'\n');
    }).catch(async error=>{
      appendEvidence(`${this.directory}/failed-decisions.jsonl`,JSON.stringify({at:new Date().toISOString(),input,visibleHand,elapsedMs:Date.now()-started,error:error.message})+'\n');
      throw error;
    });
    const parts=output.response.split(/\s+/);
    if(parts[0]==='PLAY'&&!visibleHand.includes(parts[1]))throw Error('Bot discard absent from visible hand');
    const pending={input,output,metrics,searchSeconds,executable,visibleHand:[...visibleHand],ledger:nextLedger,elapsedMs:Date.now()-started,observedAt:new Date().toISOString(),verified:false,estimatedHistory:this.estimatedHistory??null};
    appendEvidence(`${this.directory}/decisions.jsonl`,JSON.stringify(pending)+'\n');
    this.pending=pending;
    return this.pending;
  }
  async dismissUnexecutedCall() {
    const pending=this.pending;
    if(!pending||!['CHI','PENG','GANG'].includes(pending.output.response.split(' ')[0]))throw Error('Pending call required');
    // The response window closed without changing our melds. Retain the
    // observed public prefix, but never commit the unexecuted call/discard.
    this.requests=[...pending.input.requests];
    this.responses=[...pending.input.responses,'PASS'];
    this.ledger=structuredClone(pending.ledger);
    this.pending=null;
    appendEvidence(`${this.directory}/confirmations.jsonl`,JSON.stringify({at:new Date().toISOString(),action:'PASS',unexecutedAction:pending.output.response,source:'visible-unchanged-melds-and-closed-call'})+'\n');
  }
  async confirm(observedAction) {
    if(!this.pending||observedAction!==this.pending.output.response)throw Error('Client action does not match pending decision');
    const kind=observedAction.split(/\s+/)[0];
    const publicAction=['PLAY','LIZHI','CHI','PENG','GANG','ANGANG','BUGANG'].includes(kind)
      ? {state:`3 ${this.seat} ${observedAction}`,validact:null}:null;
    const ledger=publicAction?applyPublicEvent(this.pending.ledger,publicAction):this.pending.ledger;
    const requests=[...this.pending.input.requests];
    const responses=[...this.pending.input.responses,observedAction];
    // The frozen bot reconstructs state from requests, not responses. A
    // verified own action must therefore also enter the public event stream.
    // Callers must not feed this same own-action notification a second time.
    if(publicAction) {
      requests.push(publicAction);
      responses.push('PASS');
    }
    appendEvidence(`${this.directory}/confirmations.jsonl`,JSON.stringify({at:new Date().toISOString(),action:observedAction,decisionAt:this.pending.observedAt})+'\n');
    this.requests=requests;this.responses=responses;this.ledger=ledger;
    this.pending=null;
  }
}
