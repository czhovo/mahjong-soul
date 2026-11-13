import {countNoProgress} from './no-progress-limit.mjs';
// Choose the currently recognized button instead of a fixed page sequence.
export class MatchContinuation {
 constructor({onRecovery=()=>{},allowRematch=true}={}){this.onRecovery=onRecovery;this.allowRematch=allowRematch;this.beginGame();}
 beginGame(){this.noProgressCount=0;this.exitAfterResults=!this.allowRematch;this.lastClick=-Infinity;this.page=null;this.seenAt=0;this.actions=[];this.index=0;this.previousAction=null;this.progressAt=null;this.completionFrame=null;}
 finish(){this.noProgressCount=0;this.previousAction=null;this.progressAt=null;this.page=null;}
 async step(frame,adapter,now=performance.now()){
  const phase=frame.terminal_phase,controls=phase?.controls??{};
  if(!this.allowRematch&&this.previousAction&&phase?.name==='unknown'&&now-this.lastClick>=2000){
   if(!this.completionFrame)this.completionFrame={id:frame.id,at:now};
   else if(frame.id!==this.completionFrame.id&&now-this.completionFrame.at>=1500)return 'FINISHED';
  }else this.completionFrame=null;
  // Prefer rematching whenever its button is visible.
  const action=phase?.name!=='match_end'?null:this.exitAfterResults&&controls.EXIT?'EXIT':
    !this.exitAfterResults&&controls.REMATCH?'REMATCH':
    this.allowRematch&&controls.REMATCH_CONFIRM?'REMATCH_CONFIRM':controls.CONFIRM?'CONFIRM':controls.EXIT?'EXIT':null;
  // The final rematch confirmation starts matchmaking; both visible and
  // missing-button retries must respect the longer interval.
  if(this.previousAction?.action==='REMATCH_CONFIRM'&&(!action||action==='REMATCH_CONFIRM')){
   if(now-this.progressAt>=30000){
    countNoProgress(this,30);this.progressAt=now;this.lastClick=now;
    await adapter.sendClick(frame,[...(controls.REMATCH_CONFIRM?.center??this.previousAction.center)]);
    await this.onRecovery('REMATCH_CONFIRM',30);
   }
   return null;
  }
  if(!action){
   this.page=null;
   if(this.previousAction&&now-this.progressAt>=10000){
    countNoProgress(this);this.progressAt=now;this.lastClick=now;
    await adapter.sendClick(frame,[...this.previousAction.center]);
    await this.onRecovery(this.previousAction.action,10);
   }
   return null;
  }
  const key=JSON.stringify([action,controls[action].center]);
  if(this.page!==key){this.page=key;this.seenAt=now;}
  if(now-this.lastClick<2000||now-this.seenAt<2000)return null;
  this.lastClick=now;
  this.noProgressCount=0;this.progressAt=now;this.previousAction={action,center:[...controls[action].center]};
  await adapter.sendClick(frame,controls[action].center);
  this.actions.push(action);this.index=this.actions.length;
  return action;
 }
}
