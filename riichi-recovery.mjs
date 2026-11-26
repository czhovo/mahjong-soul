import {sameReactionWindow} from './reaction-window.mjs';
import {unchangedDiscard} from './unchanged-discard.mjs';
export async function retryUnchangedRiichi(adapter,pending){
 if(!pending.decision.output.response.startsWith('LIZHI ')||pending.riichiAccepted||
    performance.now()-(pending.lastRiichiButtonRetryAt??pending.sentAt??pending.started)<800)return null;
 const current=await adapter.inspect({phase:'auto',meld_count:pending.before.hand.meld_count});
 if(current.id===pending.lastRiichiButtonRetryFrame||
    Number.isFinite(current.captureStartedMono)&&current.captureStartedMono<(pending.lastRiichiButtonRetryAt??pending.sentAt??pending.started))return null;
 const discard={...pending.decision,output:{response:pending.decision.output.response.replace(/^LIZHI /,'PLAY ')}};
 if(!current.controls?.LIZHI||!(unchangedDiscard(discard,pending.before,current,{ownPrompt:true})||sameReactionWindow(pending.before,current)))return null;
 // Each retry requires another fresh unchanged prompt, including after an
 // uncertain receipt. There is no one-attempt cap on a visibly failed click.
 pending.buttonRetried=true;
 pending.lastRiichiButtonRetryAt=performance.now();pending.lastRiichiButtonRetryFrame=current.id;
 const center=current.controls.LIZHI.center;
 const receipt=await adapter.sendClick(current,[center[0],center[1]+18]);
 return {status:'special_button_retried',action:pending.decision.output.response,before:pending.before.id,frame:current.id,receipt,totalMs:performance.now()-pending.started,recovery:true};
}
