import {GAME} from './game-rules.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {hasTsumoHand} from './tsumo-guard.mjs';
import {hasSpareNorth} from './auto-kita-effect.mjs';

// null means recognition is incomplete; false means the first turn has passed.
export function nineTerminalsOpening(frame){
 const positions=GAME.positions;
 for(const p of positions){
  const river=frame.rivers?.[p],meld=p==='self'?frame.own_melds:frame.opponent_melds?.[p];
  if(meld?.groups?.length||river?.tiles?.length>(p==='self'?0:1))return false;
 }
 if(positions.some(p=>!frame.rivers?.[p]?.complete||!(p==='self'?frame.own_melds:frame.opponent_melds?.[p])?.complete))return null;
 const seats=frame.round?.seat_identity;
 if(!seats?.verified||!Number.isInteger(seats.seats?.self))return null;
 for(const p of positions){
  if(!Number.isInteger(seats.seats[p]))return null;
  if(frame.rivers[p].tiles.length!==(seats.seats[p]<seats.seats.self?1:0))return false;
 }
 return true;
}

function winPriority(frame){
 if(frame.controls?.TSUMO||frame.controls?.HU||frame.controls?.RONG)return true;
 // Thirteen distinct terminals in fourteen tiles is already kokushi, even
 // while the self-draw button is still animating into view.
 const tiles=frame.hand?.complete?frame.hand.tiles.map(t=>t.tile):[];
 if(tiles.length===14&&tiles.every(t=>/^([WBT][19]|Z[1-7])$/.test(t))&&new Set(tiles).size===13)return true;
 return hasTsumoHand(frame);
}

export function nineTerminalsChoice(frame){
 if(!frame.controls?.KYUSHU||winPriority(frame)||nineTerminalsOpening(frame)!==true)return null;
 const hand=frame.hand;
 if(!hand?.complete||hand.tiles.length!==14||hand.meld_count!==0)return null;
 const tiles=hand.tiles.map(t=>t.tile);
 if(tiles.some(t=>! /^(?:[WBT][0-9]|Z[1-7])$/.test(t)))return null;
 const count=new Set(tiles.filter(t=>/^([WBT][19]|Z[1-7])$/.test(t))).size;
 if(count<9)return null;
 const action='PASS';
 const control=frame.controls[action];
 if(!control)return null;
 return {count,action,center:control.center};
}

// Consume this client-only prompt before any opening/recovery or bot request.
// Each retry uses a fresh frame proving that the same button is still present.
export async function resolveNineTerminals(frame,{inspect,adapter,signal,report=()=>{},record=async()=>{},now=()=>performance.now(),wait=()=>delay(100,undefined,{signal})}){
 let lastSent=-Infinity,lastNotice=null;
 while(frame.controls?.KYUSHU||(adapter.kokushiRoute?.active&&frame.controls?.KITA&&!hasSpareNorth(frame))){
  if(signal?.aborted)throw Object.assign(Error('Nine terminals handling stopped'),{name:'AbortError'});
  // Leave wins to the existing HU/auto-win path; never wait here or press PASS.
  const locked=adapter.kokushiRoute?.active===true;
  if(winPriority(frame)||(!locked&&nineTerminalsOpening(frame)===false))return frame;
  if(locked&&await adapter.kokushiRoute.disableAutoNorth(frame,adapter)){
   await wait();
   frame=await inspect();
   continue;
  }
  if(Object.keys(frame.controls).some(k=>!['KYUSHU','PASS',...(locked&&!hasSpareNorth(frame)?['KITA']:[])].includes(k))){
   const controls={...frame.controls};delete controls.KYUSHU;
   // Keep the observation bound to adapter.latest and its original targets.
   frame.controls=controls;return frame;
  }
  const choice=nineTerminalsChoice(frame)??(locked&&frame.hand?.complete&&!frame.hand.rejected?.length&&frame.controls.PASS?{action:'PASS',center:frame.controls.PASS.center}:null);
  if(choice&&now()-lastSent>=1200){
   try{
    await adapter.sendClick(frame,choice.center);
    lastSent=now();
    const message=choice.count?`九种九牌：${choice.count}种幺九牌，继续打牌`:'国士无双路线，跳过拔北';
    if(lastNotice!==message){report(message);lastNotice=message;}
    await record({kind:'nine_terminals_input',frame:frame.id,count:choice.count,action:choice.action});
   }catch(error){
    if(error.name==='AbortError')throw error;
    lastSent=now();
    const message=`九种九牌操作未发送，重新识别后重试：${error.message}`;
    if(lastNotice!==message){report(message);lastNotice=message;}
   }
  }
  await wait();
  frame=await inspect();
 }
 return frame;
}
