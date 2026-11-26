import {GAME} from './game-rules.mjs';
import {declaredSeats} from './confirmed-riichi.mjs';
import {isDamaYakuLess} from './hand-evaluator.mjs';
import {shapeWaits} from './tenpai-hint.mjs';

export function currentScores(context,frame,history){
 const sticks=frame?.round?.counters?.riichi_sticks;
 const seats=frame?.round?.seat_identity;
 if(frame?.table_scores?.complete&&seats?.verified&&Number.isInteger(sticks)){
  const points=GAME.seats.map(seat=>{
   const position=GAME.positions.find(p=>seats.seats[p]===seat);
   return frame.table_scores.scores[position]?.value;
  });
  if(points.every(p=>Number.isInteger(p)&&p%100===0)&&points.reduce((a,b)=>a+b,0)+1000*sticks===GAME.bank)return points;
 }
 // The engine context uses opening balances, including on mid-hand recovery.
 if(!context||context.estimated||!GAME.seats.every(s=>Number.isInteger(context.scores?.[s])))return null;
 const declared=declaredSeats(history);
 if(Number.isInteger(sticks)&&sticks!==context.riichi_sticks+declared.size)return null;
 return context.scores.map((points,seat)=>points-(declared.has(seat)?1000:0));
}

function resolveWind(frame,history,wind){
 if(Number.isInteger(wind))return wind;
 if(Number.isInteger(frame?.round?.wind))return frame.round.wind;
 let found=null;
 for(const r of history??[]){
  const w=(r?.state??'').trim().split(/\s+/);
  if(w[0]==='0'&&Number.isInteger(Number(w[2])))found=Number(w[2]);
 }
 return found;
}

function classifyRiichiTiles(actions,hand,ownMelds,seat,wind,visibleCounts){
 const lizhiIndex=actions.findIndex(a=>a.split(/\s+/)[0]==='LIZHI');
 if(lizhiIndex<0||!Array.isArray(hand))return null;
 const listed=actions[lizhiIndex].split(/\s+/).slice(1);
 const tiles=listed.length
  ?listed
  :[...new Set(hand)].filter(tile=>{
   const rest=hand.slice();
   const i=rest.indexOf(tile);
   if(i<0)return false;
   rest.splice(i,1);
   const raw=shapeWaits(rest,ownMelds);
   const waits=raw&&GAME.sanma?raw.filter(w=>!/^W[2-8]$/.test(w)):raw;
   return !!(waits&&waits.length>0);
  });
 if(!tiles.length)return null;
 const exempt=[],restricted=[];
 for(const tile of tiles){
  if(isDamaYakuLess(hand,tile,ownMelds,{seat,wind,visibleCounts,sanma:GAME.sanma}))exempt.push(tile);
  else restricted.push(tile);
 }
 return {lizhiIndex,exempt,restricted};
}

export function restrictEndgameRiichi(event,context,seat,frame,history,{
 hand=null,
 ownMelds=null,
 wind=null,
 visibleCounts=null,
}={}){
 const isEndgame=context?.is_last_scheduled_hand===true||(Number.isInteger(context?.remaining_scheduled_hands)&&context.remaining_scheduled_hands<=1);
 if(!isEndgame||!event.state?.trim().startsWith('2 '))return event;
 const actions=event.validact?.split(',').map(a=>a.trim()).filter(Boolean);
 if(!actions?.some(a=>a.split(/\s+/)[0]==='LIZHI'))return event;
 const resolvedHand=Array.isArray(hand)?hand:(frame?.hand?.complete?frame.hand.tiles.map(t=>t.tile):null);
 const resolvedMelds=Array.isArray(ownMelds)?ownMelds:(frame?.own_melds?.complete?frame.own_melds.groups:[]);
 const resolvedWind=resolveWind(frame,history,wind);
 const split=classifyRiichiTiles(actions,resolvedHand,resolvedMelds,seat,resolvedWind,visibleCounts);
 const exemptTiles=split?.exempt??[];
 const restrictedTiles=split?.restricted??null;

 const scores=currentScores(context,frame,history);
 const order=context.tie_priority;
 const validOrder=Array.isArray(order)&&GAME.seats.every(s=>order.includes(s));
 if(scores&&validOrder){
  const rank=points=>1+GAME.seats.filter(other=>other!==seat&&(scores[other]>points||
   (scores[other]===points&&order.indexOf(other)<order.indexOf(seat)))).length;
  const before=rank(scores[seat]);
  if(rank(scores[seat]-1000)===before){
   if(before>1)return event;
   if(scores[seat]-1000>=GAME.endPoints){
    // Endgame 1st place: only dama-yaku tiles require the 60% win-rate floor;
    // dama-yaku-less riichi tiles are never blocked by endgame restrictions.
    if(restrictedTiles&&restrictedTiles.length===0)return event;
    return {
     ...event,
     minimumRiichiWinProbability:0.60,
     ...(exemptTiles.length?{endgameRiichiExemptTiles:exemptTiles}:{}),
    };
   }
  }
 }
 // Endgame restriction forbids riichi for dama-yaku tiles, but must never block
 // dama-yaku-less riichi declarations.
 if(exemptTiles.length>0){
  const nextActions=actions.map((a,i)=>i===split.lizhiIndex?'LIZHI '+exemptTiles.join(' '):a);
  return {...event,validact:nextActions.join(',')};
 }
 return {...event,validact:actions.filter(a=>a.split(/\s+/)[0]!=='LIZHI').join(',')};
}
