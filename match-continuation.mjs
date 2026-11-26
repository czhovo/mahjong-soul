import {countNoProgress} from './no-progress-limit.mjs';
// Choose the currently recognized button instead of a fixed page sequence.
export class MatchContinuation {
 constructor({onResult=()=>false,onRecovery=()=>{},allowRematch=true}={}){this.onResult=onResult;this.onRecovery=onRecovery;this.allowRematch=allowRematch;this.beginGame();}
 beginGame(){this.noProgressCount=0;this.exitAfterResults=!this.allowRematch;this.resultProcessed=false;this.resultScreenshotSaved=false;this.lastClick=-Infinity;this.page=null;this.seenAt=0;this.actions=[];this.index=0;this.previousAction=null;this.progressAt=null;this.completionFrame=null;this.rematchSeen=false;}
 finish(){this.noProgressCount=0;this.previousAction=null;this.progressAt=null;this.page=null;this.rematchSeen=false;}
 async step(frame,adapter,now=performance.now(),checkedRight=false){
  const phase=frame.terminal_phase,controls=phase?.controls??{};
  if(!this.allowRematch&&this.previousAction&&phase?.name==='unknown'&&now-this.lastClick>=2000){
   if(!this.completionFrame)this.completionFrame={id:frame.id,at:now};
   else if(frame.id!==this.completionFrame.id&&now-this.completionFrame.at>=1500)return 'FINISHED';
  }else this.completionFrame=null;
  // Prefer rematching whenever its button is visible.
  const action=phase?.name!=='match_end'?null:this.exitAfterResults&&controls.EXIT?'EXIT':
    this.allowRematch&&controls.REMATCH_CONFIRM?'REMATCH_CONFIRM':
    this.allowRematch&&controls.REMATCH?'REMATCH':!this.rematchSeen&&controls.CONFIRM?'CONFIRM':null;
  if(action==='REMATCH')this.rematchSeen=true; // Locks out EXIT, never supplies a click coordinate.
  if(this.previousAction?.action==='REMATCH_CONFIRM'){
   if(now-this.progressAt>=30000){
    countNoProgress(this,30);this.progressAt=now;
   }
   if(action==='REMATCH_CONFIRM'&&now-this.lastClick>=30000){
    this.lastClick=now;await adapter.sendClick(frame,controls[action].center);
    await this.onRecovery(action,30);
   }
   return null;
  }
  if(!action){
   this.page=null;
   this.progressAt??=now;
   if(now-this.progressAt>=10000){
    countNoProgress(this);this.progressAt=now;
    const last=this.previousAction;
    if(last&&!(this.allowRematch&&last.action==='CONFIRM'&&(this.rematchSeen||controls.EXIT))){
     this.lastClick=now;
     await adapter.sendClick(frame,[...last.center]);
     await this.onRecovery(last.action,10);
    }
   }
   return null;
  }
  const center=controls[action].center;
  const key=action==='REMATCH'?action:JSON.stringify([action,center]);
  if(this.page!==key){this.page=key;this.seenAt=now;}
  if(now-this.lastClick<2000||(!checkedRight&&!this.previousAction&&now-this.seenAt<2000))return null;
  if(this.allowRematch&&action==='CONFIRM'&&!checkedRight&&adapter.recheckEndButtons){
   // Right also dismisses the rewards page. Resolve the target using the
   // latest game frame once the input driver and the click interval are ready.
   const fresh=await adapter.recheckEndButtons();
   if(fresh.start_page?.page==='lobby')return null;
   const sent=await this.step(fresh,adapter,now,true);
   return sent;
  }
  this.lastClick=now;
  if(!this.resultProcessed&&action==='CONFIRM'&&frame.result_page?.kind==='match-result'){
   await this.onResult(frame.result_page);this.resultProcessed=true;
  }
  await adapter.sendClick(frame,center);
  this.previousAction={action,center:[...center]};
  this.progressAt=now;this.noProgressCount=0;
  this.actions.push(action);this.index=this.actions.length;
  return action;
 }
}
