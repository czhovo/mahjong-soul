import {GAME} from './game-rules.mjs';
import {roundIdentity} from './round-boundary.mjs';

const incompleteOpening=new Set([
 'Incomplete opening','Opening prefix incomplete','Opening kita count incomplete',
 'Opening hand still sorting or missing an interior tile','Dealer opening draw not fully visible',
]);

// An unread dealing frame cannot be repaired by interpreting it as midgame.
// Keep the existing snapshot route when public events establish a later state.
export function canRecoverOpening(frame,error){
 if(!roundIdentity(frame)||!frame.hand?.complete||!frame.dora?.complete)return false;
 const laterEvents=frame.dora.tiles.length>1||frame.rivers?.self?.tiles?.length>0||
  GAME.positions.some(p=>frame.rivers?.[p]?.tiles?.length>1||
   (p==='self'?frame.own_melds:frame.opponent_melds?.[p])?.groups?.length>0);
 return laterEvents||!incompleteOpening.has(error.message);
}

// Report an entry failure only when it repeatedly blocks a visible own action.
// Passive opening animation is not a blocked decision, regardless of duration.
export class OpeningEntryProgress {
 constructor(){this.reset();}
 reset(){this.round=null;this.reasons=new Map();}
 observe(frame,reason){
  const round=JSON.stringify(roundIdentity(frame));
  if(round!==this.round){this.reset();this.round=round;}
  const h=frame.hand,m=frame.own_melds,c=frame.controls??{};
  const ownDraw=!!(h?.complete&&m?.complete&&h.tiles.length===14-3*m.groups.length);
  const timer=frame.time_reserve;
  const ownCountdown=!!(timer?.verified&&Number.isInteger(timer.action_seconds)&&timer.action_seconds>=0);
  const active=ownDraw||ownCountdown||!!frame.selection?.verified||!!frame.call_choices?.verified||
   ['PASS','CHI','PENG','GANG','ANGANG','BUGANG','KITA','LIZHI','TSUMO','RONG','HU','KYUSHU'].some(k=>c[k]);
  if(!active){for(const retry of this.reasons.values())retry.frames=0;return false;}
  const retry=this.reasons.get(reason)??{frames:0,lastFrame:null,reported:false};
  if(frame.id&&retry.lastFrame!==frame.id){retry.frames++;retry.lastFrame=frame.id;}
  this.reasons.set(reason,retry);
  if(retry.frames<2||retry.reported)return false;
  retry.reported=true;return true;
 }
}
