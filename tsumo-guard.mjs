import {shapeWaits} from './tenpai-hint.mjs';
import {waitYaku} from './wait-details.mjs';
export function hasTsumoHand(frame){
 if(!frame?.hand?.complete||frame.result_page||frame.settlement?.complete||frame.terminal_phase?.name==='match_end')return false;
 const melds=frame.own_melds?.groups??[];
 if(frame.own_melds?.complete===false)return false;
 const hand=frame.hand.tiles.map(t=>t.tile),win=hand.pop();
 const norm=t=>/^[WBT]0$/.test(t)?t[0]+'5':t;
 if(!(shapeWaits(hand,melds)??[]).includes(norm(win)))return false;
 const r=frame.round;
 // Event yaku can make an otherwise yaku-less open hand a legal self draw.
 // The client remains responsible for authorizing HU via its actual button.
 if(r?.remaining?.value===0||frame.rinshan_verified===true)return true;
 return waitYaku(hand,melds,win,{seat:r?.seat_identity?.seats?.self,wind:r?.wind}).tsumo.length>0;
}
export function awaitingTsumoControl(frame){return hasTsumoHand(frame)&&!frame.controls?.HU&&!frame.controls?.TSUMO;}

// Bind replacement-draw evidence to this exact hand/round. Merely having an
// old kong is not evidence for rinshan on a later ordinary draw.
export function sameRinshanDraw(frame,confirmed){
 if(!confirmed||!frame.hand?.complete||!frame.own_melds?.complete)return false;
 const key=f=>{
  const r=f.round;
  if(!Number.isInteger(r?.wind)||!Number.isInteger(r?.hand_number?.value)||!Number.isInteger(r?.counters?.honba)||!Number.isInteger(r?.seat_identity?.seats?.self))return null;
  return JSON.stringify([r.wind,r.hand_number.value,r.counters.honba,r.seat_identity.seats.self,
   f.hand.tiles.map(t=>t.tile),f.own_melds.groups.map(g=>[g.kind,g.tiles]),
   f.rivers?.self?.tiles?.map(t=>t.tile)]);
 };
 const a=key(frame);return a!==null&&a===key(confirmed);
}

export function blocksTsumoDiscard(frame){
 return !!(frame?.controls?.HU||frame?.controls?.TSUMO||frame?.controls?.RONG)||
  (hasTsumoHand(frame)&&frame.tsumo_rechecked_no_control!==true);
}
// A local shape/yaku inference may request two fresh observations, never an
// unbounded wait. Only actual client controls authorize winning.
export class TsumoControlProbe {
 constructor(){this.frames=new Set();this.rechecked=false;}
 check(frame){
  delete frame.tsumo_rechecked_no_control;
  if(!awaitingTsumoControl(frame)){this.frames.clear();this.rechecked=false;return false;}
  if(!this.rechecked){
   this.frames.add(frame.id);
   // Initial candidate plus two distinct subsequent captures.
   if(this.frames.size<3)return true;
  }
  this.rechecked=true;frame.tsumo_rechecked_no_control=true;return false;
 }
}
