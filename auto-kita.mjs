// Both a North decision and confirmed riichi can enable the fifth toolbar switch.
import {toolbarPoint} from './toolbar-point.mjs';
export class AutoKita {
 async update(frame,adapter,{riichiConfirmed=false,kitaDecision=false,allowKokushiFallback=false}={}){
  this.confirmedNow=false;
  this.receipt=null;
  if(adapter.kokushiRoute?.active&&!allowKokushiFallback)return false;
  if(!kitaDecision&&!adapter.autoKitaOutput?.requested&&!(riichiConfirmed&&
     (frame.auto_win?.verified?frame.auto_win.enabled:adapter.autoWinOutput?.sentAt!=null)))return false;
  const state=adapter.autoKitaOutput??={sentAt:null,confirmed:false,onFrames:0,lastOnFrame:null,offFrames:0,lastFrame:null,unverifiedFrames:0,lastUnverifiedFrame:null};
  if(kitaDecision&&!allowKokushiFallback)state.requested=true;
  const toggle=frame.auto_kita;
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
   if(state.sentAt===null)return false;
   if(state.lastUnverifiedFrame!==frame.id){state.unverifiedFrames=(state.unverifiedFrames??0)+1;state.lastUnverifiedFrame=frame.id;}
   if(state.unverifiedFrames<3||performance.now()-state.sentAt<2000)return false;
  }else{
   state.unverifiedFrames=0;state.lastUnverifiedFrame=null;
   if(state.lastFrame!==frame.id){state.offFrames++;state.lastFrame=frame.id;}
   if(state.sentAt!==null&&(state.offFrames<2||performance.now()-state.sentAt<1000))return false;
  }
  try{this.receipt=await adapter.sendClick(adapter.latest??frame,toolbarPoint(frame,'kita3'),"toggle");}catch(error){
   if(error.outputOutcomeUnknown){
    state.sentAt=performance.now();state.confirmed=false;state.onFrames=0;state.lastOnFrame=null;state.offFrames=0;state.unverifiedFrames=0;state.lastUnverifiedFrame=null;state.lastFrame=frame.id;
    error.autoKitaOutputPending=true;
   }
   throw error;
  }
  state.sentAt=performance.now();state.confirmed=false;state.onFrames=0;state.lastOnFrame=null;state.offFrames=0;state.unverifiedFrames=0;state.lastUnverifiedFrame=null;state.lastFrame=frame.id;
  return true;
 }
}

export async function applyKitaDecision(frame,adapter,{allowKokushiFallback=false}={}){
 const toggle=new AutoKita();
 const sent=await toggle.update(frame,adapter,{kitaDecision:true,allowKokushiFallback});
 return {autoKita:true,sent,confirmedNow:toggle.confirmedNow,enabled:!!(frame.auto_kita?.verified&&frame.auto_kita.enabled),receipt:toggle.receipt};
}
