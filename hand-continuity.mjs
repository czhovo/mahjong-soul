import {GAME} from './game-rules.mjs';
import {roundIdentity,roundAdvanced} from './round-boundary.mjs';
// Device workers may be replaced; these objects belong to the hand, not the window.
export class HandContinuity{
 retain(state){this.state=state;}
 get(frame){
  const round=roundIdentity(frame);
  if(!round||!this.state)return null;
  if(JSON.stringify(round)===JSON.stringify(this.state.round))return this.state;
  const old=this.state.round??roundIdentity(this.state.pump?.anchor?.before);
  if(!old)return null;
  // Seat glyphs alone cannot start another hand. A stale/contradictory
  // identity on reconnect does not consume the retained event stream.
  if(!GAME.sanma||roundAdvanced(old,round))this.clear();
  return null;
 }
 clear(){this.state?.session?.pending?.callSearch?.cancel();this.state=null;}
}
export function reconnectAdapter(before,after){
 for(const k of ['call','callWaitEvidence','discardEvidence','kitaEvidence','points','pointSeats','roundStartRiichiSticks','searchBudget','publicFrameId','inputCompletedMono','lastMatchArchive'])
  if(before[k]!==undefined)after[k]=before[k];
 if(after.callWaitEvidence)after.callWaitEvidence.onDetected=e=>after.onCallWaitDetected?.(e);
}
