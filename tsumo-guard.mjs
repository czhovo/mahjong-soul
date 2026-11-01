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
 return waitYaku(hand,melds,win,{seat:r?.seat_identity?.seats?.self,wind:r?.wind}).tsumo.length>0;
}
export function awaitingTsumoControl(frame){return hasTsumoHand(frame)&&!frame.controls?.HU;}
