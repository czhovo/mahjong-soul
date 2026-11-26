import {GAME} from './game-rules.mjs';
export function roundIdentity(frame){
 const r=frame?.round,wind=r?.wind,hand=r?.hand_number?.value,honba=r?.counters?.honba;
 const seats=r?.seat_identity?.seats;
 if(!r?.seat_identity?.verified||!Number.isInteger(wind)||wind<0||wind>3||
    !Number.isInteger(hand)||hand<1||hand>GAME.players||!Number.isInteger(honba)||honba<0||
    GAME.positions.map(p=>seats?.[p]).sort().join(',')!==GAME.seats.join(','))return null;
 return {wind,hand,honba,seats:Object.fromEntries(GAME.positions.map(p=>[p,seats[p]]))};
}
export function roundAdvanced(a,b){
 return a&&b&&(b.wind>a.wind||b.wind===a.wind&&(b.hand>a.hand||b.hand===a.hand&&b.honba>a.honba));
}
function nextHand(a,b){
 if(GAME.sanma)return roundAdvanced(a,b);
 const repeat=b.wind===a.wind&&b.hand===a.hand&&b.honba===a.honba+1;
 const rotate=b.hand===a.hand%4+1&&b.wind===a.wind+(a.hand===4?1:0)&&
   (b.honba===0||b.honba===a.honba+1);
 return (repeat||rotate)&&GAME.positions.every(p=>b.seats[p]===(a.seats[p]+(rotate?3:0))%4);
}
export function conflictingRound(before,after){
 const a=roundIdentity(before),b=roundIdentity(after);
 return a&&b&&JSON.stringify(a)!==JSON.stringify(b)&&!nextHand(a,b);
}
export const conflictingSanmaRound=(a,b)=>GAME.sanma&&conflictingRound(a,b);
export function changedRound(before,after){
 const a=roundIdentity(before),b=roundIdentity(after);
 return a&&b&&nextHand(a,b)?{before:a,after:b}:null;
}

function observedRemaining(frame){
 const rem=frame?.round?.remaining;
 if(!rem)return null;
 return rem.estimated?rem.observedValue:rem.value;
}
function multisetAddedCount(beforeTiles,afterTiles){
 const counts=new Map();
 for(const tile of beforeTiles)counts.set(tile,(counts.get(tile)??0)+1);
 let added=0;
 for(const tile of afterTiles){
  const n=counts.get(tile)??0;
  if(n>0)counts.set(tile,n-1);
  else added++;
 }
 return added;
}
export function isLobbyFrame(frame){
 return Boolean(frame&&(frame.terminal_phase?.name==='lobby'||frame.start_page?.page==='lobby'));
}
export function isTableAbsent(frame){
 if(!frame)return false;
 if(frame.terminal_phase?.name==='match_end'||isLobbyFrame(frame))return false;
 if(frame.settlement?.complete)return false;
 if(['own-win-settlement','match-result'].includes(frame.result_page?.kind))return false;
 if(roundIdentity(frame))return false;
 const r=frame.round;
 if(r?.wind!=null||r?.hand_number?.value!=null||r?.seat_identity?.verified)return false;
 if((frame.hand?.tiles?.length??0)>0||(frame.dora?.tiles?.length??0)>0)return false;
 if(Object.keys(frame.controls??{}).length>0)return false;
 if(frame.selection?.verified||frame.call_choices?.verified)return false;
 return true;
}
// Detect a physically new hand dealt under the same (wind, hand, honba, seats)
// identity — e.g. abortive draw with lagging/unchanged honba or friendly-room
// restart into East 1 / 0 honba. Every branch requires an invariant that is
// impossible within a single continuing hand.
export function isSameRoundReset(before,after){
 const a=roundIdentity(before),b=roundIdentity(after);
 if(!a||!b||JSON.stringify(a)!==JSON.stringify(b))return null;
 if(!before?.hand?.complete||!after?.hand?.complete||after.hand.rejected?.length)return null;
 if(!before?.own_melds?.complete||!after?.own_melds?.complete)return null;
 if(after.selection?.verified||after.call_choices?.verified)return null;
 const beforeMelds=before.own_melds.groups?.length??0;
 const afterMelds=after.own_melds.groups?.length??0;
 if(afterMelds<beforeMelds)return 'own_melds_shrank';
 const wallBefore=observedRemaining(before),wallAfter=observedRemaining(after);
 const wallIncreased=Number.isInteger(wallBefore)&&Number.isInteger(wallAfter)&&wallAfter>wallBefore;
 const wallJumpedUp=wallIncreased&&(wallAfter-wallBefore>=4||wallAfter>=GAME.initialWall-4);
 const selfBefore=before.rivers?.self?.tiles?.length??0;
 const selfAfter=after.rivers?.self?.tiles?.length??0;
 const allRiversComplete=GAME.positions.every(p=>before.rivers?.[p]?.complete&&after.rivers?.[p]?.complete);
 const totalRiversBefore=GAME.positions.reduce((s,p)=>s+(before.rivers?.[p]?.tiles?.length??0),0);
 const totalRiversAfter=GAME.positions.reduce((s,p)=>s+(after.rivers?.[p]?.tiles?.length??0),0);
 if(wallJumpedUp&&((selfBefore>=1&&selfAfter===0&&after.rivers?.self?.complete)||
    (allRiversComplete&&totalRiversBefore>=2&&totalRiversAfter<totalRiversBefore))){
  return 'wall_and_rivers_reset';
 }
 const beforeHand=before.hand.tiles.map(t=>t.tile),afterHand=after.hand.tiles.map(t=>t.tile);
 const newTiles=multisetAddedCount(beforeHand,afterHand);
 if(wallJumpedUp&&afterMelds===0&&newTiles>=4)return 'wall_reset_and_new_hand';
 const doraChanged=Boolean(before.dora?.complete&&after.dora?.complete&&
   before.dora.tiles?.[0]?.tile&&after.dora.tiles?.[0]?.tile&&
   before.dora.tiles[0].tile!==after.dora.tiles[0].tile);
 if(beforeMelds===0&&afterMelds===0&&selfAfter===0&&after.rivers?.self?.complete&&
    Number.isInteger(wallAfter)&&wallAfter>=GAME.initialWall-GAME.players-1&&
    newTiles>=5&&(wallIncreased||doraChanged)){
  return 'turn1_abortive_new_hand';
 }
 return null;
}

// Tracks sustained abnormal match exits (returned to lobby / left table in a
// friendly match) and abnormal round changes (non-adjacent match jump or
// same-round abortive-draw reset) with consecutive-frame confirmation so
// transient animations and single-frame OCR glitches never false-trigger.
export class AbnormalBoundaryTracker {
 constructor({
  lobbyConfirmFrames=2,
  nonTableExitMs=12000,
  nonTableExitFrames=4,
  conflictConfirmMs=1000,
  conflictConfirmFrames=3,
  sameRoundResetFrames=2,
  now=()=>performance.now(),
 }={}){
  this.lobbyConfirmFrames=lobbyConfirmFrames;
  this.nonTableExitMs=nonTableExitMs;
  this.nonTableExitFrames=nonTableExitFrames;
  this.conflictConfirmMs=conflictConfirmMs;
  this.conflictConfirmFrames=conflictConfirmFrames;
  this.sameRoundResetFrames=sameRoundResetFrames;
  this.now=now;
  this.reset();
 }
 reset(){
  this.sawSettlement=false;
  this.lobby=null;
  this.absent=null;
  this.conflict=null;
  this.sameReset=null;
 }
 markSettlement(){
  this.sawSettlement=true;
  this.lobby=null;
  this.absent=null;
 }
 observe(anchorBefore,frame,{resetBaseline=anchorBefore}={}){
  const at=this.now();
  const id=frame?.id??Symbol('frame');
  if(isLobbyFrame(frame)){
   this.absent=null;this.conflict=null;this.sameReset=null;
   if(!this.lobby)this.lobby={frames:1,lastId:id,since:at};
   else if(this.lobby.lastId!==id){this.lobby.frames++;this.lobby.lastId=id;}
   if(this.lobby.frames>=this.lobbyConfirmFrames){
    return {status:'match_ended',abnormal:true,reason:'returned_to_lobby',frame:frame.id};
   }
   return {status:'waiting_round_frame',frame:frame.id,reason:'confirming_lobby_exit'};
  }
  this.lobby=null;
  if(isTableAbsent(frame)){
   this.conflict=null;this.sameReset=null;
   if(!this.absent)this.absent={frames:1,lastId:id,since:at};
   else if(this.absent.lastId!==id){this.absent.frames++;this.absent.lastId=id;}
   const elapsedMs=at-this.absent.since;
   if(this.absent.frames>=this.nonTableExitFrames&&elapsedMs>=this.nonTableExitMs){
    return {status:'match_ended',abnormal:true,reason:'left_table',frame:frame.id,elapsedMs};
   }
   return null;
  }
  this.absent=null;
  if(anchorBefore&&conflictingRound(anchorBefore,frame)){
   this.sameReset=null;
   if(frame.hand?.complete&&!frame.hand.rejected?.length&&frame.own_melds?.complete&&
      !frame.selection?.verified&&!frame.call_choices?.verified){
    const after=roundIdentity(frame),key=JSON.stringify(after);
    if(!this.conflict||this.conflict.key!==key)this.conflict={key,frames:1,lastId:id,since:at};
    else if(this.conflict.lastId!==id){this.conflict.frames++;this.conflict.lastId=id;}
    const minFrames=this.sawSettlement?Math.min(2,this.conflictConfirmFrames):this.conflictConfirmFrames;
    const minMs=this.sawSettlement?0:this.conflictConfirmMs;
    if(this.conflict.frames>=minFrames&&at-this.conflict.since>=minMs){
     return {status:'round_boundary',abnormal:true,reason:'unexpected_round_change',
      before:roundIdentity(anchorBefore),after,frame:frame.id};
    }
   }
   return {status:'waiting_round_frame',frame:frame.id,reason:'confirming_unexpected_round_change'};
  }
  this.conflict=null;
  const resetReason=resetBaseline?isSameRoundReset(resetBaseline,frame):null;
  if(resetReason){
   const sig=JSON.stringify(frame.hand.tiles.map(t=>t.tile).sort());
   if(!this.sameReset||this.sameReset.sig!==sig)this.sameReset={sig,frames:1,lastId:id,since:at,reason:resetReason};
   else if(this.sameReset.lastId!==id){this.sameReset.frames++;this.sameReset.lastId=id;this.sameReset.reason=resetReason;}
   const minFrames=(this.sawSettlement&&resetReason!=='turn1_abortive_new_hand')?1:this.sameRoundResetFrames;
   if(this.sameReset.frames>=minFrames){
    const identity=roundIdentity(frame);
    return {status:'round_boundary',abnormal:true,sameRoundReset:true,reason:resetReason,
     before:roundIdentity(anchorBefore)??identity,after:identity,frame:frame.id};
   }
   return {status:'waiting_round_frame',frame:frame.id,reason:`confirming_same_round_reset:${resetReason}`};
  }
  this.sameReset=null;
  return null;
 }
}
