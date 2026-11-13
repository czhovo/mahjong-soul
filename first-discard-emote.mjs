export async function firstDiscardEmote(event,frame,adapter,state,round){
 if(state.done)return false;
 // Confirmation can precede the river animation. Remember it independently
 // and send only from a later observation, outside the confirmation callback.
 if(['confirmation','discard_confirmed_by_next_hand'].includes(event.kind)&&/^(PLAY|LIZHI) /.test(event.action??''))state.pending=true;
 if(!state.pending||event.kind!=='visible_frame'||!round)return false;
 if(!state.takeover&&(round.wind!==0||round.hand!==1||round.honba!==0))return false;
 if(!frame?.rivers?.self?.complete||frame.rivers.self.tiles.length<1)return false;
 // Optional UI input must not consume a frame needed for a game action.
 if(!frame.hand?.complete||!frame.own_melds?.complete||frame.hand.tiles.length!==13-3*frame.own_melds.groups.length)return false;
 if(['PASS','CHI','PENG','GANG','ANGANG','BUGANG','LIZHI','HU','RONG','TSUMO'].some(k=>frame.controls?.[k])||frame.selection?.verified||frame.call_choices?.verified)return false;
 if(!Number.isFinite(frame.clientWidth)||!Number.isFinite(frame.clientHeight))return false;
 // Right-side emote button: inside its left edge; retain calibrated scaling.
 const center=[1+frame.clientWidth*1310/1366,31+frame.clientHeight*408/768];
 center.doubleClick500=true;
 // Reserve once before sending: an uncertain receipt must not toggle repeatedly.
 state.done=true;
 state.attempts=(state.attempts??0)+1;
 delete state.reason;delete state.receipt;
 try{state.receipt=await adapter.sendClick(frame,center);}
 catch(error){
  state.reason=error.message;
  if(error.inputNotSent){state.done=false;state.outcome='not_sent';return false;}
  if(error.outputOutcomeUnknown){state.outcome='unknown';return false;}
  throw error;
 }
 state.pending=false;state.outcome='input_sent';
 return true;
}
