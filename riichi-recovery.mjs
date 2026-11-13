import {sameReactionWindow} from './reaction-window.mjs';
export async function retryUnchangedRiichi(adapter,pending){
 if(pending.buttonRetried||!pending.decision.output.response.startsWith('LIZHI ')||performance.now()-pending.started<2500)return null;
 const current=await adapter.inspect({phase:'auto',meld_count:pending.before.hand.meld_count});
 if(!current.controls?.LIZHI||!sameReactionWindow(pending.before,current))return null;
 // Mark before issuing input: an uncertain driver outcome cannot permit
 // another attempt. Keep the original transaction and timing throughout.
 pending.buttonRetried=true;
 const center=current.controls.LIZHI.center;
 const receipt=await adapter.sendClick(current,[center[0],center[1]+18]);
 return {status:'special_button_retried',action:pending.decision.output.response,before:pending.before.id,frame:current.id,receipt,totalMs:performance.now()-pending.started,recovery:true};
}
