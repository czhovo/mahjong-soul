import {setTimeout as delay} from 'node:timers/promises';
import {hasTsumoHand} from './tsumo-guard.mjs';

// null means recognition is incomplete; false means the first turn has passed.
export function nineTerminalsOpening(frame){
 const positions=['self','right','opposite','left'];
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
 if(tiles.length===14&&new Set(tiles.filter(t=>/^([WBT][19]|Z[1-7])$/.test(t))).size===13)return true;
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
 const action=count<=10?'KYUSHU':'PASS';
 const control=frame.controls[action];
 if(!control)return null;
 return {count,action,center:control.center};
}

// Consume this client-only prompt before any opening/recovery or bot request.
// Each retry uses a fresh frame proving that the same button is still present.
export async function resolveNineTerminals(frame,{inspect,adapter,signal,report=()=>{},record=async()=>{},now=()=>performance.now(),wait=()=>delay(100,undefined,{signal})}){
 let lastSent=-Infinity,lastNotice=null;
 while(frame.controls?.KYUSHU){
  if(signal?.aborted)throw Object.assign(Error('Nine terminals handling stopped'),{name:'AbortError'});
  // Leave wins to the existing HU/auto-win path; never wait here or press PASS.
  if(winPriority(frame)||nineTerminalsOpening(frame)===false)return frame;
  const choice=nineTerminalsChoice(frame);
  if(choice&&now()-lastSent>=1200){
   try{
    await adapter.sendClick(frame,choice.center);
    lastSent=now();
    const message=`九种九牌：${choice.count}种幺九牌，${choice.action==='KYUSHU'?'选择流局':'继续打牌'}`;
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
