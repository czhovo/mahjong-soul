import {shapeWaits} from './tenpai-hint.mjs';
import {toolbarPoint} from './toolbar-point.mjs';
import {GAME} from './game-rules.mjs';
export class AutoWin {
  async update(frame,adapter,{winDecision=false}={}){
    this.confirmedNow=false;
    this.receipt=null;
    const state=adapter.autoWinOutput??={sentAt:null,confirmed:false,onFrames:0,lastOnFrame:null,offFrames:0,lastFrame:null,unverifiedFrames:0,lastUnverifiedFrame:null};
    const toggle=frame.auto_win;
    if(state.sentAt!==null&&(!Number.isFinite(frame.captureStartedMono)||frame.captureStartedMono<state.sentAt))return false;
    if(toggle?.verified&&toggle.enabled){
      state.offFrames=0;state.unverifiedFrames=0;
      if(state.sentAt===null){
        state.confirmed=true;state.onFrames=2;state.lastOnFrame=frame.id;return false;
      }
      if(state.lastOnFrame!==frame.id){state.onFrames=(state.onFrames??0)+1;state.lastOnFrame=frame.id;}
      if(state.onFrames>=2){
        if(!state.confirmed)this.confirmedNow=true;
        state.confirmed=true;
      }
      return false;
    }
    state.onFrames=0;state.lastOnFrame=null;
    if(!toggle?.verified){
      state.offFrames=0;
      if(state.confirmed)return false;
      if(state.sentAt===null){
        if(!winDecision)return false;
      }else{
        if(state.lastUnverifiedFrame!==frame.id){state.unverifiedFrames=(state.unverifiedFrames??0)+1;state.lastUnverifiedFrame=frame.id;}
        if(state.unverifiedFrames<3||performance.now()-state.sentAt<2000)return false;
      }
    }else{
      state.unverifiedFrames=0;state.lastUnverifiedFrame=null;
      if(state.lastFrame!==frame.id){state.offFrames++;state.lastFrame=frame.id;}
      // After an input, use two independently captured OFF frames before retrying.
      // Never use an older screenshot to toggle the now-enabled switch back off.
      if(state.sentAt!==null&&(state.offFrames<2||performance.now()-state.sentAt<1000))return false;
    }
    if(!winDecision){
      if(!frame.hand?.complete||!frame.own_melds?.complete||Object.keys(frame.controls??{}).length)return false;
      const waits=shapeWaits(frame.hand.tiles.map(t=>t.tile),frame.own_melds.groups);
      if(!waits?.length)return false;
    }
    try{this.receipt=await adapter.sendClick(adapter.latest??frame,toolbarPoint(frame,GAME.sanma?'win3':'win4'),"toggle");}catch(error){
      if(error.outputOutcomeUnknown){
        // Recovery can stop the driver after the toggle reached the game.
        // Keep the same fresh-frame confirmation gate as an acknowledged click.
        state.sentAt=performance.now();state.confirmed=false;state.onFrames=0;state.lastOnFrame=null;state.offFrames=0;state.unverifiedFrames=0;state.lastUnverifiedFrame=null;state.lastFrame=frame.id;
        error.autoWinOutputPending=true;
      }
      throw error;
    }
    state.sentAt=performance.now();state.confirmed=false;state.onFrames=0;state.lastOnFrame=null;state.offFrames=0;state.unverifiedFrames=0;state.lastUnverifiedFrame=null;state.lastFrame=frame.id;
    return true;
  }
}

export async function applyWinDecision(frame,adapter){
  const toggle=new AutoWin();
  const sent=await toggle.update(frame,adapter,{winDecision:true});
  return {autoWin:true,sent,confirmedNow:toggle.confirmedNow,enabled:!!(frame.auto_win?.verified&&frame.auto_win.enabled),receipt:toggle.receipt};
}
