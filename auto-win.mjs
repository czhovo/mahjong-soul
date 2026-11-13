import {shapeWaits} from './tenpai-hint.mjs';
export class AutoWin {
  async update(frame,adapter){
    this.confirmedNow=false;
    const state=adapter.autoWinOutput??={sentAt:null,confirmed:false,offFrames:0,lastFrame:null};
    const toggle=frame.auto_win;
    if(state.sentAt!==null&&(!Number.isFinite(frame.captureStartedMono)||frame.captureStartedMono<state.sentAt))return false;
    if(!toggle?.verified)return false;
    if(toggle.enabled){
      if(state.sentAt!==null&&!state.confirmed)this.confirmedNow=true;
      state.confirmed=true;state.offFrames=0;return false;
    }
    if(state.lastFrame!==frame.id){state.offFrames++;state.lastFrame=frame.id;}
    // After an input, use two independently captured OFF frames before retrying.
    // Never use an older screenshot to toggle the now-enabled switch back off.
    if(state.sentAt!==null&&(state.offFrames<2||performance.now()-state.sentAt<1000))return false;
    if(!frame.hand?.complete||!frame.own_melds?.complete||Object.keys(frame.controls??{}).length)return false;
    const waits=shapeWaits(frame.hand.tiles.map(t=>t.tile),frame.own_melds.groups);
    if(!waits?.length)return false;
    try{await adapter.sendClick(adapter.latest,toggle.center);}catch(error){
      if(error.outputOutcomeUnknown){
        // Recovery can stop the driver after the toggle reached the game.
        // Keep the same fresh-frame confirmation gate as an acknowledged click.
        state.sentAt=performance.now();state.confirmed=false;state.offFrames=0;state.lastFrame=frame.id;
        error.autoWinOutputPending=true;
      }
      throw error;
    }
    state.sentAt=performance.now();state.confirmed=false;state.offFrames=0;state.lastFrame=frame.id;
    return true;
  }
}
