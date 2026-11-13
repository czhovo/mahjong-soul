import {riichiEvents} from './confirmed-riichi.mjs';
import {randomUUID} from 'node:crypto';
import {engineExchange} from './engine-exchange.mjs';
import {parseDecisionTelemetry} from './decision-telemetry.mjs';
import {GAME,remainingHands} from './game-rules.mjs';
import {annotateDiscardRequests} from './discard-evidence.mjs';
import {appendEvidence} from './background-evidence.mjs';
import {verifyEngineBuild} from './engine-builds.mjs';
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
    if(this.ledger||this.requests.length||this.responses.length)throw Error('Opening initialization requires a new hand session');
    if(!Number.isInteger(seat)||seat<0||seat>=GAME.players||hand.length!==13) throw Error('Invalid initial public state');
    if(typeof indicator!=='string'||!indicator.trim()||indicator.trim().split(/\s+/).some(t=>!/^(?:[WBT][0-9]|Z[1-7])$/.test(t)))throw Error('Dora indicators must use the frozen protocol string format');
    this.requests=[{state:`0 ${seat} ${round}`,validact:null},{handTiles:`1 ${hand.join(' ')}`,doraIndicators:indicator,validact:null}];
    this.responses=['PASS','PASS']; this.context=context; this.pending=null; this.seat=seat;
    this.ledger=initialLedger(seat,hand);
    this.opponentHandConstraints=undefined;
    this.currentDora=[];this.discardObservation=undefined;
  }
  observe(event) {
    if(this.pending)throw Error('Confirm or resolve pending action before recording another event');
    [event]=riichiEvents([event],this.requests);
    this.ledger=applyPublicEvent(this.ledger,event);
    this.requests.push(event); this.responses.push('PASS');
  }
  restoreSnapshot(snapshot){
    if(this.ledger||this.requests.length||this.responses.length)throw Error('Snapshot initialization requires a new hand session');
    if(this.pending)throw Error('Cannot replace history with a pending mouse action');
    const restored=riichiEvents(structuredClone(snapshot.requests));
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
    this.snapshotBoundary={id:snapshot.frameId,actorCertain:snapshot.chronologyCertain===true,river:snapshot.boundaryRivers};
    this.estimatedHistory={frameId:snapshot.frameId,assumptions:snapshot.assumptions};
  }
  observeVerified(transition,visibleHand) {
    if(this.pending)throw Error('Confirm pending action before recording a transition');
    if(!transition?.verified||!Array.isArray(transition.requests))throw Error('Unverified public transition');
    // Validate the entire batch before committing any request. A failed final
    // hand check must not leave an extra DRAW or half of a call in history.
    let ledger=structuredClone(this.ledger);
    const events=riichiEvents(transition.requests,this.requests);
    for(const event of events)ledger=applyPublicEvent(ledger,event);
    assertVisibleHand(ledger,visibleHand);
    this.ledger=ledger;
    this.requests.push(...events);
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
    [event]=riichiEvents([event],reuseObserved?this.requests.slice(0,-1):this.requests);
    if(reuseObserved&&(this.requests.at(-1)?.state!==event.state||this.responses.at(-1)!=='PASS'))
      throw Error('Late reaction must target the latest observed event');
    const nextLedger=reuseObserved?structuredClone(this.ledger):applyPublicEvent(this.ledger,event);
    assertVisibleHand(nextLedger,visibleHand);
    this.currentDora=currentIndicators(this.requests,this.discardObservation,this.currentDora);
    if(this.currentDora.length)event={...event,doraIndicators:this.currentDora.join(' ')};
    if(GAME.sanma&&Number.isInteger(this.discardObservation?.round?.remaining?.value))event={...event,remaining:this.discardObservation.round.remaining.value};
    const input={requests:[...(reuseObserved?this.requests.slice(0,-1):this.requests),event],responses:reuseObserved?this.responses.slice(0,-1):[...this.responses],data:null,match_context:this.context};
    // Correct the engine projection at the source discard without rewriting committed observations.
    for(const {index,events} of missingOpenKongs(this.requests,this.discardObservation)){
      input.requests.splice(index,0,...events);input.responses.splice(index,0,...events.map(()=> 'PASS'));
    }
    if(GAME.sanma){
      const r=this.discardObservation?.round;
      input.match_context={...this.context,return_points:GAME.returnPoints,end_threshold_points:GAME.endPoints,placement_bonuses:[...GAME.placement]};
      if(Number.isInteger(r?.wind)&&Number.isInteger(r?.hand_number?.value)){
        input.match_context.hand_index=GAME.players*r.wind+r.hand_number.value;
        input.match_context.remaining_scheduled_hands=remainingHands(r.wind,r.hand_number.value);
        input.match_context.is_last_scheduled_hand=input.match_context.remaining_scheduled_hands===1;
      }
    }
    input.requests=annotateDiscardRequests(input.requests,this.discardObservation);
    if(this.opponentHandConstraints?.schema===2)
      input.opponent_hand_constraints=structuredClone(this.opponentHandConstraints);
    const started=Date.now();
    let metrics,telemetry,callSearch;
    input.call_search={schema:1,id:randomUUID(),mode:"continue_after_call"};
    const searchSeconds=this.searchBudget?.seconds??this.verifiedBudgetEngine?.searchSeconds??5.5;
    let executable=this.executable;
    if([1.7,2.2,3.5].includes(searchSeconds)){
      this.verifiedBudgetEngine??=await verifyEngineBuild(this.executable);
      if(searchSeconds===this.verifiedBudgetEngine.reducedSearchSeconds||(!this.verifiedBudgetEngine.reducedSearchSeconds&&searchSeconds===1.7))executable=this.verifiedBudgetEngine.reducedExecutable??this.executable;
    }
    const output=await engineExchange(executable,input,{signal,onPhaseStart:()=>this.searchBudget?.beginSearch?.(),onPhaseEnd:()=>this.searchBudget?.endSearch?.()}).then(result=>{
      const response=result.output.response,kind=response?.trim().split(/\s+/)[0];
      const allowed=(event.validact??'').split(',').map(x=>x.trim().split(/\s+/)[0]);
      if(kind==='PASS'&&!allowed.includes('PASS'))throw Object.assign(Error('Bot returned PASS outside a reaction window'),{code:'BOT_INVALID_RESULT'});
      callSearch=result.callSearch;
      telemetry=result.output.telemetry??parseDecisionTelemetry(result.stderr,response);
      metrics=decisionMetrics(result.stderr,response,input);return result.output;
    }).catch(async error=>{
      appendEvidence(`${this.directory}/failed-decisions.jsonl`,JSON.stringify({at:new Date().toISOString(),input,visibleHand,elapsedMs:Date.now()-started,error:error.message})+'\n');
      throw error;
    });
    const parts=output.response.split(/\s+/);
    if(parts[0]==='PLAY'&&!visibleHand.includes(parts[1]))throw Error('Bot discard absent from visible hand');
    const pending={input,output,metrics,telemetry,searchSeconds,executable,visibleHand:[...visibleHand],ledger:nextLedger,elapsedMs:Date.now()-started,observedAt:new Date().toISOString(),verified:false,estimatedHistory:this.estimatedHistory??null};
    appendEvidence(`${this.directory}/decisions.jsonl`,JSON.stringify(pending)+'\n');
    if(callSearch)pending.callSearch=callSearch;
    this.pending=pending;
    return this.pending;
  }
  async dismissUnexecutedCall() {
    const pending=this.pending;
    if(!pending||!['CHI','PENG','GANG'].includes(pending.output.response.split(' ')[0]))throw Error('Pending call required');
    pending.callSearch?.cancel();
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
    const publicAction=['PLAY','LIZHI','CHI','PENG','GANG','ANGANG','BUGANG','KITA'].includes(kind)
      ? {state:`3 ${this.seat} ${observedAction}`,validact:null}:null;
    const ledger=publicAction?applyPublicEvent(this.pending.ledger,publicAction):this.pending.ledger;
    const requests=[...this.pending.input.requests];
    const responses=[...this.pending.input.responses,observedAction];
    // The frozen bot reconstructs state from requests, not responses. A
    // verified own action must therefore also enter the public event stream.
    // Callers must not feed this same own-action notification a second time.
    if(requests.at(-1)?.observedCallBeforeDiscard&&kind==='PLAY'){
      // Once verified, retain the normal complete PENG event for all later
      // decisions. The discard has already been applied to the pending ledger.
      const {observedCallBeforeDiscard,...pon}=requests.pop();
      requests.push({...pon,state:pon.state+' '+observedAction.split(' ')[1],validact:null});
      responses[responses.length-1]='PASS';
    }else if(publicAction) {
      requests.push(publicAction);
      responses.push('PASS');
    }
    appendEvidence(`${this.directory}/confirmations.jsonl`,JSON.stringify({at:new Date().toISOString(),action:observedAction,decisionAt:this.pending.observedAt})+'\n');
    this.pending.callSearch?.cancel();
    this.requests=requests;this.responses=responses;this.ledger=ledger;
    this.pending=null;
  }
}
