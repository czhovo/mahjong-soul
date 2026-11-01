import {countNoProgress} from './no-progress-limit.mjs';
// Choose the currently recognized button instead of a fixed page sequence.
export class MatchContinuation {
 constructor({onResult=()=>false,onRecovery=()=>{}}={}){this.onResult=onResult;this.onRecovery=onRecovery;this.beginGame();}
 beginGame(){this.noProgressCount=0;this.exitAfterResults=false;this.resultProcessed=false;this.resultScreenshotSaved=false;this.lastClick=-Infinity;this.page=null;this.seenAt=0;this.actions=[];this.index=0;this.previousAction=null;this.progressAt=null;}
 finish(){this.noProgressCount=0;this.previousAction=null;this.progressAt=null;this.page=null;}
 async step(frame,adapter,now=performance.now()){
  const phase=frame.terminal_phase,controls=phase?.controls??{};
  // EXIT denotes the confirmation beside REMATCH; retain loss cooldown.
  const action=phase?.name!=='match_end'?null:this.exitAfterResults&&controls.EXIT?'EXIT':
    !this.exitAfterResults&&controls.REMATCH?'REMATCH':
    controls.REMATCH_CONFIRM?'REMATCH_CONFIRM':controls.CONFIRM?'CONFIRM':controls.EXIT?'EXIT':null;
  if(!action){
   this.page=null;
   if(this.previousAction&&now-this.progressAt>=10000){
    countNoProgress(this);this.progressAt=now;this.lastClick=now;
    await adapter.sendClick(frame,[...this.previousAction.center]);
    await this.onRecovery(this.previousAction.action);
   }
   return null;
  }
  const key=JSON.stringify([action,controls[action].center]);
  if(this.page!==key){this.page=key;this.seenAt=now;}
  if(now-this.lastClick<2000||now-this.seenAt<2000)return null;
  this.lastClick=now;
  this.noProgressCount=0;this.progressAt=now;this.previousAction={action,center:[...controls[action].center]};
  if(!this.resultScreenshotSaved&&action==='CONFIRM'&&frame.result_page?.kind==='match-result'){
   await adapter.finalizeMatchScreenshot?.(frame);this.resultScreenshotSaved=true;
  }
  if(!this.resultProcessed&&action==='CONFIRM'){
   this.exitAfterResults=!!await this.onResult(frame.result_page);this.resultProcessed=true;
  }
  await adapter.sendClick(frame,controls[action].center);
  this.actions.push(action);this.index=this.actions.length;
  return action;
 }
}
