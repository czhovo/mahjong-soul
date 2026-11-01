import {countNoProgress} from './no-progress-limit.mjs';
export const startActionName={RANK:'段位场',BRONZE:'铜之间',SILVER:'银之间',GOLD:'金之间',EAST:'四人东'};
export class StartFlow{
 constructor({bronze=false,gold=false,onRecovery=()=>{}}={}){
  this.actions=['RANK',gold?'GOLD':bronze?'BRONZE':'SILVER','EAST'];this.index=0;
  this.previous=null;this.lastClick=-Infinity;this.seenAt=null;this.onRecovery=onRecovery;this.finished=false;
 }
 reset(){this.noProgressCount=0;this.index=0;this.previous=null;this.lastClick=-Infinity;this.seenAt=null;this.finished=false;}
 finish(){this.noProgressCount=0;this.finished=true;}
 async step(frame,adapter,now=performance.now()){
  if(this.finished)return null;
  const controls=frame.start_page?.controls??{};
  // Starting on a later lobby page is valid. The visible page establishes
  // the next action; do not require clicks that happened before startup.
  if(this.index<this.actions.length){
   const visibleIndex=controls.EAST?2:controls[this.actions[1]]?1:controls.RANK?0:-1;
   if(visibleIndex>this.index){this.noProgressCount=0;this.index=visibleIndex;this.seenAt=null;this.previous=null;}
  }
  const action=this.actions[this.index];
  if(action&&controls[action]){
   this.seenAt??=now;
   if(now-this.lastClick<2000||now-this.seenAt<2000)return null;
   this.noProgressCount=0;this.previous={action,center:[...controls[action].center]};this.lastClick=now;
   this.index++;this.seenAt=null;
   await adapter.sendClick(frame,this.previous.center);
   return action;
  }
  this.seenAt=null;
  // Retry only while the previous button's page remains visible. After EAST
  // disappears the client is matching: an ordinary queue wait is not a stall.
  if(this.previous&&controls[this.previous.action]&&now-this.lastClick>=10000){
   countNoProgress(this);this.lastClick=now;
   await adapter.sendClick(frame,controls[this.previous.action].center);
   await this.onRecovery(this.previous.action);
  }
  return null;
 }
}
