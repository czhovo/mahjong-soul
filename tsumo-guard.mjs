import {GAME} from './game-rules.mjs';
import {declaredSeats} from './confirmed-riichi.mjs';
import {shapeWaits} from './tenpai-hint.mjs';
import {waitYaku} from './wait-details.mjs';

const KOKUSHI_ORPHANS='W1 W9 B1 B9 T1 T9 Z1 Z2 Z3 Z4 Z5 Z6 Z7'.split(' ');
const norm=t=>typeof t==='string'&&/^[WBT]0$/.test(t)?t[0]+'5':t;

export function isKokushiComplete(tiles){
 if(!Array.isArray(tiles)||tiles.length!==14)return false;
 const counts=new Map();
 for(const t of tiles){
  if(!KOKUSHI_ORPHANS.includes(t))return false;
  counts.set(t,(counts.get(t)??0)+1);
 }
 return KOKUSHI_ORPHANS.every(t=>(counts.get(t)??0)>=1)&&[...counts.values()].some(n=>n===2);
}

function roundMetaFromHistory(history){
 let seat=null,wind=null;
 const ownDiscards=new Set();
 for(const r of history??[]){
  const w=(r?.state??'').trim().split(/\s+/);
  if(w[0]==='0'){
   const s=Number(w[1]),wd=Number(w[2]);
   seat=Number.isInteger(s)?s:null;
   wind=Number.isInteger(wd)?wd:null;
   ownDiscards.clear();
   continue;
  }
  if(w[0]==='3'&&Number.isInteger(seat)&&Number(w[1])===seat){
   if((w[2]==='PLAY'||w[2]==='LIZHI')&&w[3])ownDiscards.add(norm(w[3]));
   else if((w[2]==='CHI'||w[2]==='PENG')&&w.length===7&&w[6])ownDiscards.add(norm(w[6]));
  }
 }
 return {seat,wind,ownDiscards};
}

function resolveSeatWindRiichi(frame,{riichi=false,history=null}={}){
 const r=frame?.round;
 const meta=history?roundMetaFromHistory(history):{seat:null,wind:null,ownDiscards:new Set()};
 const seat=Number.isInteger(r?.seat_identity?.seats?.self)?r.seat_identity.seats.self:meta.seat;
 const wind=Number.isInteger(r?.wind)?r.wind:meta.wind;
 const isRiichi=riichi===true||!!frame?.rivers?.self?.tiles?.some(t=>t.sideways===true)||
  (history&&Number.isInteger(seat)&&declaredSeats(history).has(seat));
 return {seat,wind,isRiichi,ownDiscards:meta.ownDiscards};
}

// Pure static yaku check for self-draw win; never treats incidental yaku
// (haitei/rinshan) as sufficient to constitute a valid winning hand.
export function hasTsumoHand(frame,{melds=null,riichi=false,history=null,kokushiRouteActive=false}={}){
 if(!frame?.hand?.complete||frame.hand.rejected?.length||frame.result_page||frame.settlement?.complete||frame.terminal_phase?.name==='match_end')return false;
 const ownMelds=Array.isArray(melds)?melds:(frame.own_melds?.complete===false?null:(frame.own_melds?.groups??[]));
 if(!Array.isArray(ownMelds))return false;
 const hand=frame.hand.tiles.map(t=>t.tile);
 if(hand.length!==14-3*ownMelds.length)return false;
 if(kokushiRouteActive===true)return ownMelds.length===0&&isKokushiComplete(hand);
 const win=hand.pop();
 const rawWaits=shapeWaits(hand,ownMelds);
 const waits=rawWaits&&GAME.sanma?rawWaits.filter(w=>!/^W[2-8]$/.test(w)):rawWaits;
 if(!(waits??[]).includes(norm(win)))return false;
 const {seat,wind,isRiichi}=resolveSeatWindRiichi(frame,{riichi,history});
 return waitYaku(hand,ownMelds,win,{seat,wind,riichi:isRiichi}).tsumo.length>0;
}

// Pure static yaku + furiten check for ron on an opponent's discard;
// excludes incidental yaku (houtei/chankan).
export function hasRonHand(frame,discardTile,{melds=null,riichi=false,history=null,ownDiscards=null,tempFuriten=false,kokushiRouteActive=false}={}){
 if(!discardTile||!frame?.hand?.complete||frame.hand.rejected?.length||frame.result_page||frame.settlement?.complete||frame.terminal_phase?.name==='match_end')return false;
 if(tempFuriten===true)return false;
 const ownMelds=Array.isArray(melds)?melds:(frame.own_melds?.complete===false?null:(frame.own_melds?.groups??[]));
 if(!Array.isArray(ownMelds))return false;
 const hand=frame.hand.tiles.map(t=>t.tile);
 if(hand.length!==13-3*ownMelds.length)return false;
 const rawWaits=shapeWaits(hand,ownMelds);
 const waits=rawWaits&&GAME.sanma?rawWaits.filter(w=>!/^W[2-8]$/.test(w)):rawWaits;
 if(!(waits??[]).includes(norm(discardTile)))return false;
 const {seat,wind,isRiichi,ownDiscards:historyDiscards}=resolveSeatWindRiichi(frame,{riichi,history});
 const discardSet=new Set(historyDiscards);
 for(const t of frame.rivers?.self?.tiles??[]){
  const code=typeof t==='object'?t?.tile:t;
  if(code)discardSet.add(norm(code));
 }
 for(const t of ownDiscards??[]){
  const code=typeof t==='object'?t?.tile:t;
  if(code)discardSet.add(norm(code));
 }
 if(waits.some(w=>discardSet.has(w)))return false;
 if(kokushiRouteActive===true)return ownMelds.length===0&&isKokushiComplete([...hand,discardTile]);
 return waitYaku(hand,ownMelds,discardTile,{seat,wind,riichi:isRiichi}).ron.length>0;
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

export function blocksTsumoDiscard(frame,{melds=null,riichi=false,history=null,kokushiRouteActive=false}={}){
 return hasTsumoHand(frame,{melds,riichi,history,kokushiRouteActive})&&frame?.tsumo_rechecked_no_control!==true;
}

// Retained for legacy imports/tests; live win resolution is handled by AutoWinGuard.
export class TsumoControlProbe {
 constructor(){this.frames=new Set();this.rechecked=false;}
 check(frame){
  delete frame.tsumo_rechecked_no_control;
  if(!awaitingTsumoControl(frame)){this.frames.clear();this.rechecked=false;return false;}
  if(!this.rechecked){
   this.frames.add(frame.id);
   if(this.frames.size<3)return true;
  }
  this.rechecked=true;frame.tsumo_rechecked_no_control=true;return false;
 }
}
