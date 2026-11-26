import {roundIdentity} from './round-boundary.mjs';
import {GAME} from './game-rules.mjs';
import {confirmedNorthStock} from './kita-evidence.mjs';
import {hasSeparatedDraw} from './draw-separation.mjs';
import {declaredSeats} from './confirmed-riichi.mjs';
import {shapeWaits} from './tenpai-hint.mjs';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const wall=f=>f.round?.remaining?.estimated?f.round.remaining.observedValue:f.round?.remaining?.value;
const tiles=f=>f.hand?.tiles?.map(t=>t.tile)??[];
const river=r=>r.tiles.map(t=>[t.tile,t.sideways]);
const groups=m=>m?.groups?.map(g=>[g.kind,g.tiles?.map(t=>t.tile??t)]);
export function hasSpareNorth(frame){
 return frame?.hand?.complete&&!frame.hand.rejected?.length&&tiles(frame).filter(t=>t==='Z4').length>1;
}
export function singleNorthReady(frame){
 return hasSpareNorth(frame)&&!!frame.controls?.KITA&&frame.auto_kita?.verified&&frame.auto_kita.enabled===false;
}
export function automaticNorthDraw(frame,toggleState,draw){
 if(!GAME.sanma||!frame)return false;
 const enabled=toggleState?.requested||toggleState?.confirmed||(frame.auto_kita?.verified&&frame.auto_kita.enabled);
 if(!enabled)return false;
 // Mahjong Soul pauses in-game AutoKita whenever LIZHI / TSUMO / HU is offered
 // (e.g. a replacement draw enters tenpai while another Z4 remains in hand).
 if(frame.controls?.LIZHI||frame.controls?.TSUMO||frame.controls?.HU)return false;
 // Automatic extraction cannot occur when the wall is empty or total kans + kita reached 8.
 const rem=wall(frame);
 if(Number.isInteger(rem)&&rem<1)return false;
 const kans=GAME.positions.flatMap(p=>(p==='self'?frame.own_melds:frame.opponent_melds?.[p])?.groups??[])
  .filter(g=>['GANG','ANGANG','BUGANG'].includes(g.kind)).length;
 const norths=GAME.positions.reduce((n,p)=>n+(Number.isInteger(frame.kita?.[p]?.count)?frame.kita[p].count:0),0);
 if(kans+norths>=8)return false;
 if(draw==='Z4')return true;
 if(!frame.hand?.complete||!frame.own_melds?.complete||
    frame.hand.tiles.length!==14-3*frame.own_melds.groups.length)return false;
 return frame.hand.tiles.at(-1)?.tile==='Z4'||!!(frame.controls?.KITA&&frame.hand.tiles.some(t=>t.tile==='Z4'));
}
export function unchangedKitaTable(a,b,{local=false}={}){
 const id=roundIdentity(a);
 return !!id&&same(id,roundIdentity(b))&&GAME.positions.every(p=>{
  const m=f=>p==='self'?f.own_melds:f.opponent_melds?.[p];
  const optional=local&&p!=='self';
  if(optional){
   // During our own kita chain, an old opponent river/meld tile OCR flip (e.g. B7<->B8)
   // must never deadlock chain confirmation; only check that no new opponent discard/meld appeared.
   const riverOk=!(a.rivers?.[p]?.complete&&b.rivers?.[p]?.complete)||a.rivers[p].tiles.length===b.rivers[p].tiles.length;
   const meldOk=!(m(a)?.complete&&m(b)?.complete)||(m(a).groups?.length??0)===(m(b).groups?.length??0);
   return riverOk&&meldOk;
  }
  return (a.rivers?.[p]?.complete&&b.rivers?.[p]?.complete&&same(river(a.rivers[p]),river(b.rivers[p])))&&
   (m(a)?.complete&&m(b)?.complete&&same(groups(m(a)),groups(m(b))));
 });
}
// Recover the ordered draw sequence for `n` consecutive own north extractions.
// When multiple distinct unseen draws enter the hand (original hand held >=2 Z4),
// place unseen Z4 draws first so every intermediate KITA Z4 stays ledger-legal
// while flagging `orderCertain: false` instead of deadlocking.
export function northDraws(prior,frame,n,{requireConfirmedStock=true,allowUnordered=false}={}){
 const stock=frame.kita?.self,h=frame.hand;
 if(!Number.isInteger(n)||n<1||n>4||!h?.complete||h.rejected?.length||
    frame.round?.turn?.position!=='self'||!frame.own_melds?.complete||h.tiles.length!==14-3*frame.own_melds.groups.length)return null;
 if(requireConfirmedStock){
  if(!Number.isInteger(stock?.count)||stock.count<n||stock.count>4||!confirmedNorthStock(stock))return null;
 }
 if(!hasSeparatedDraw(h.tiles))return null;
 const unseen=[...tiles(frame).slice(0,-1),...Array(n).fill('Z4')];
 for(const t of prior){const i=unseen.indexOf(t);if(i<0)return null;unseen.splice(i,1);}
 const orderedUnseen=new Set(unseen).size<=1
  ?unseen
  :(allowUnordered?[...unseen.filter(t=>t==='Z4'),...unseen.filter(t=>t!=='Z4')]:null);
 if(!orderedUnseen)return null;
 let north=prior.filter(t=>t==='Z4').length;
 if(prior.length===h.tiles.length&&--north<0)return null;
 for(const draw of orderedUnseen){if(draw==='Z4')north++;if(--north<0)return null;}
 return [...orderedUnseen,tiles(frame).at(-1)];
}
// The first extraction may already be in the engine history. Return only
// the draw/extraction pairs after it, leaving the last draw for decide().
export function verifiedNorthChain(before,frame,hand,seat,{allowWallLag=false}={}){
 const oldCount=before.kita?.self?.count,stock=frame.kita?.self;
 const rawCount=stock?.count_source==='same_round_confirmed_count'?stock.observed_count:stock?.count;
 const stockConfirmed=confirmedNorthStock(stock);
 const stockDelta=Number.isInteger(oldCount)&&Number.isInteger(stock?.count)&&stockConfirmed
  ?stock.count-oldCount:null;
 const wBefore=wall(before),wAfter=wall(frame);
 const wallDelta=Number.isInteger(wBefore)&&Number.isInteger(wAfter)?wBefore-wAfter:null;
 let n=null;
 if(stockDelta!==null&&stockDelta>=2&&stockDelta<=4){
  if(wallDelta===stockDelta){
   n=stockDelta;
  }else if(allowWallLag&&(wallDelta===null||(wallDelta>=1&&wallDelta<=stockDelta))){
   // All norths in the extraction area are visually verified; tolerate transient wall OCR lag/drop.
   n=stockDelta;
  }else if(wallDelta!==null&&wallDelta>stockDelta&&wallDelta<=4&&rawCount==null){
   // Current frame strip is occluded (retained older count) while wall already reflects further extractions.
   n=wallDelta;
  }
 }else if(wallDelta!==null&&wallDelta>=2&&wallDelta<=4){
  // Wall decreased by 2..4 while extraction strip is occluded or still animating.
  const stockExceedsWall=stockConfirmed&&Number.isInteger(oldCount)&&Number.isInteger(rawCount)&&rawCount-oldCount>wallDelta;
  if(!stockExceedsWall&&(allowWallLag||!Number.isInteger(rawCount))){
   n=wallDelta;
  }
 }
 if(!Number.isInteger(n)||n<2||n>4||
    !unchangedKitaTable(before,frame,{local:true})||
    (before.dora?.complete&&frame.dora?.complete&&!same(before.dora.tiles.map(t=>t.tile),frame.dora.tiles.map(t=>t.tile))))return null;
 const draws=northDraws(hand,frame,n,{requireConfirmedStock:false,allowUnordered:true});
 if(draws?.length!==n)return null;
 const orderCertain=new Set(draws.slice(0,-1)).size<=1;
 const extra=draws.slice(0,-1).flatMap(t=>[
  {state:'2 '+t,validact:null,...(orderCertain?{}:{historyOrderCertain:false})},
  {state:'3 '+seat+' KITA Z4',validact:null,...(orderCertain?{}:{historyOrderCertain:false})},
 ]);
 return {extra,request:{state:'2 '+draws.at(-1),validact:'PLAY'},draws,count:n,orderCertain};
}
// Only fresh, stable evidence that the original offer survived auto-kita
// authorizes a manual click. Single-frame PASS/OCR flicker must not reset
// the retry timer; only round change, actual kita progress, or changed north
// count resets the offer state.
function northCountOf(frame){
 if(!frame?.hand?.complete||frame.hand.rejected?.length)return null;
 return tiles(frame).filter(t=>t==='Z4').length;
}
function kitaProgressedOrChanged(a,f){
 if(['HU','TSUMO','RONG'].some(k=>f?.controls?.[k]))return true;
 const idA=roundIdentity(a),idF=roundIdentity(f);
 if(idA&&idF&&!same(idA,idF))return true;
 const stock=f?.kita?.self;
 const count=stock?.count_source==='same_round_confirmed_count'?stock.observed_count:stock?.count;
 if(Number.isInteger(a?.kita?.self?.count)&&Number.isInteger(count)&&count>a.kita.self.count)return true;
 const na=northCountOf(a),nf=northCountOf(f);
 if(na!==null&&nf!==null&&(nf===0||nf!==na))return true;
 return false;
}
export function sameKitaOffer(a,f){
 if(!f?.controls?.KITA?.center)return false;
 if(kitaProgressedOrChanged(a,f))return false;
 return true;
}
 export function tsumoButtonCenter(frame){
  const center=frame?.controls?.TSUMO?.center??frame?.controls?.HU?.center;
  return Array.isArray(center)?[center[0],center[1]+18]:null;
 }
 export function isDamaTenpaiNorthDraw(frame,{riichi=false,history=null,draw=null,kokushiRouteActive=false}={}){
  if(!GAME.sanma||!frame||kokushiRouteActive)return null;
  if(!frame.hand?.complete||frame.hand.rejected?.length||!frame.own_melds?.complete)return null;
  const ownMelds=frame.own_melds.groups??[];
  const hand=tiles(frame);
  if(hand.length!==14-3*ownMelds.length)return null;
  const drawn=draw??hand.at(-1);
  if(drawn!=='Z4')return null;
  const seat=frame.round?.seat_identity?.seats?.self;
  const isRiichi=riichi===true||!!frame.rivers?.self?.tiles?.some(t=>t.sideways===true)||
   (history&&Number.isInteger(seat)&&declaredSeats(history).has(seat));
  if(isRiichi)return null;
  const rem=wall(frame);
  if(Number.isInteger(rem)&&rem<1)return null;
  const kans=GAME.positions.flatMap(p=>(p==='self'?frame.own_melds:frame.opponent_melds?.[p])?.groups??[])
   .filter(g=>['GANG','ANGANG','BUGANG'].includes(g.kind)).length;
  const norths=GAME.positions.reduce((n,p)=>n+(Number.isInteger(frame.kita?.[p]?.count)?frame.kita[p].count:0),0);
  if(kans+norths>=8)return null;
  const rawWaits=shapeWaits(hand.slice(0,-1),ownMelds);
  const waits=rawWaits?rawWaits.filter(w=>!/^W[2-8]$/.test(w)):null;
  if(!waits?.length)return null;
  return {active:true,waits,northWaits:waits.includes('Z4')};
 }
 export function damaNorthAction(p,frame,now=performance.now()){
  if(!p?.damaNorth||!frame)return null;
  const tsumo=tsumoButtonCenter(frame);
  if(tsumo){
   const freshTsumo=!p.tsumoClickedAt||(now-p.tsumoClickedAt>=800&&(!Number.isFinite(frame.captureStartedMono)||frame.captureStartedMono>=p.tsumoClickedAt));
   if(freshTsumo){
    p.tsumoClickedAt=now;
    return {kind:'tsumo',center:tsumo};
   }
   return {kind:'wait_tsumo'};
  }
  if(kitaProgressedOrChanged(p.before,frame))return null;
  const kitaCenter=frame.controls?.KITA?.center;
  if(!Array.isArray(kitaCenter))return null;
  if(p.manualKitaAt){
   const freshKita=now-p.manualKitaAt>=800&&(!Number.isFinite(frame.captureStartedMono)||frame.captureStartedMono>=p.manualKitaAt);
   if(!freshKita)return null;
  }
  p.damaFrames??=new Set();
  if(frame.id)p.damaFrames.add(frame.id);
  // If Z4 itself completes the hand shape, allow a brief 1-frame / 250ms grace window
  // so a slightly delayed TSUMO button is never preempted by clicking KITA.
  if(p.northWaits&&p.damaFrames.size<2&&now-(p.started??now)<250){
   return {kind:'wait_tsumo_check'};
  }
  p.manualKitaAt=now;
  return {kind:'kita',center:[kitaCenter[0],kitaCenter[1]+18]};
 }
 export function stalledKitaButton(p,f,now=performance.now()){
 const a=p.before,center=f?.controls?.KITA?.center;
 if(kitaProgressedOrChanged(a,f)){
  delete p.kitaOffer;return null;
 }
 const start=p.manualKitaAt??p.sentAt??p.started??0;
 const fresh=Number.isFinite(f?.captureStartedMono)&&f.captureStartedMono>=start;
 if(!fresh||!f?.id||f.id===a?.id)return null;
 if(!center)return null;
 const seenAt=Number.isFinite(f.captureStartedMono)?f.captureStartedMono:now;
 if(!p.kitaOffer){
  p.kitaOffer={id:f.id,lastId:f.id,time:seenAt,wallTime:now,frames:1};
  return null;
 }
 if(f.id!==p.kitaOffer.lastId){
  p.kitaOffer.lastId=f.id;
  p.kitaOffer.frames=(p.kitaOffer.frames??1)+1;
 }
 const elapsedMono=seenAt-p.kitaOffer.time;
 const elapsedWall=now-(p.kitaOffer.wallTime??now);
 if((p.kitaOffer.frames??1)<2||Math.max(elapsedMono,elapsedWall)<800||now-start<800)return null;
 delete p.kitaOffer;p.manualKitaAt=now;
 return [center[0],center[1]+18];
}
