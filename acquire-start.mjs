import {openingPrefix} from './opening-prefix.mjs';
import {snapshotRecovery} from './snapshot-recovery.mjs';

// Try the current position on every fresh frame; missing the first turn is
// not a reason to spend another 30 seconds searching for an obsolete opening.
export async function acquireStart(inspect,config,{until,signal}={}){
 let lastError='no frame';
 while(performance.now()<until&&!signal?.aborted){
  const frame=await inspect();
  try{
   const opening=openingPrefix(frame,{allowPending:true});
   if(opening.round.wind!==(config.wind??0)||opening.round.hand!==config.context.hand_index||opening.round.honba!==config.context.honba||frame.round.counters.riichi_sticks!==config.context.riichi_sticks)
    throw Error('Expected verified opening required');
   return {frame,opening};
  }catch(error){lastError=error.message;}
  try{return {frame,snapshot:snapshotRecovery(frame)};}
  catch(error){lastError=error.message;}
 }
 if(signal?.aborted)throw Object.assign(Error('Start acquisition stopped'),{name:'AbortError'});
 throw Error(`Current position acquisition ended: ${lastError}`);
}
