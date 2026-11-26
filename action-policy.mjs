import {GAME} from './game-rules.mjs';
import {declaredSeats} from './confirmed-riichi.mjs';
import {currentScores,restrictEndgameRiichi} from './endgame-riichi.mjs';
import {callCombinations} from './planned-call-choice.mjs';
import {shapeWaits} from './tenpai-hint.mjs';
import {computeShanten,evaluateDamaRiichiCap,isRedFive,normTile,tileIndex} from './hand-evaluator.mjs';

const kindOf=s=>s.split(/\s+/)[0];
const isKan=k=>k==='ANGANG'||k==='BUGANG';
const invalid=()=>Object.assign(Error('引擎未返回符合当前可选动作的候选'),{code:'BOT_INVALID_RESULT'});
const rankOf=t=>Number(normTile(t)[1]);
const samePair=(x,y)=>x.length===2&&y.length===2&&((x[0]===y[0]&&x[1]===y[1])||(x[0]===y[1]&&x[1]===y[0]));

function removeOnce(list,tile){
 const out=list.slice();
 const i=out.indexOf(tile);
 if(i<0)return null;
 out.splice(i,1);
 return out;
}

function kuikaeForbidden(kind,called,supplied){
 const c=normTile(called);
 const forbidden=new Set([c]);
 if(kind==='CHI'&&supplied.length===2){
  const n=rankOf(c);
  const ranks=supplied.map(rankOf).sort((a,b)=>a-b);
  if(ranks[0]===n+1&&ranks[1]===n+2&&n+3<=9)forbidden.add(c[0]+(n+3));
  if(ranks[0]===n-2&&ranks[1]===n-1&&n-3>=1)forbidden.add(c[0]+(n-3));
 }
 return forbidden;
}

function reconstructOwnMelds(history,seat){
 const melds=[];
 for(const r of history??[]){
  const w=(r?.state??'').trim().split(/\s+/);
  if(w[0]==='0'){melds.length=0;continue;}
  if(w[0]!=='3'||Number(w[1])!==seat)continue;
  const kind=w[2];
  if(kind==='CHI'||kind==='PENG'){
   if(w.length>=6)melds.push({kind,tiles:w.slice(3,6)});
  }else if(kind==='GANG'||kind==='ANGANG'){
   if(w[3])melds.push({kind,tiles:[w[3],w[3],w[3],w[3]]});
  }else if(kind==='BUGANG'&&w[3]){
   const target=melds.find(m=>m.kind==='PENG'&&normTile(m.tiles[0])===normTile(w[3]));
   if(target){target.kind='BUGANG';target.tiles=[...target.tiles,w[3]];}
   else melds.push({kind:'BUGANG',tiles:[w[3],w[3],w[3],w[3]]});
  }
 }
 return melds;
}

function resolveOwnMelds(frame,history,seat){
 if(frame?.own_melds?.complete===true&&Array.isArray(frame.own_melds.groups))
  return {known:true,groups:frame.own_melds.groups};
 if(frame?.own_melds?.complete===false)
  return {known:false,groups:frame.own_melds.groups??[]};
 return {known:true,groups:reconstructOwnMelds(history,seat)};
}

function parseDoraIndicators(event,frame,history){
 if(typeof event?.doraIndicators==='string'&&event.doraIndicators.trim())
  return event.doraIndicators.trim().split(/\s+/);
 if(frame?.dora?.complete&&Array.isArray(frame.dora.tiles)&&frame.dora.tiles.length)
  return frame.dora.tiles.map(t=>typeof t==='object'?t.tile:t).filter(Boolean);
 let best=[];
 for(const r of history??[]){
  const ts=r?.doraIndicators?.trim().split(/\s+/);
  if(ts?.length>best.length)best=ts;
 }
 return best;
}

function collectPublicFacts(event,frame,history,hand,ownMelds,seat){
 const riichi=declaredSeats(history);
 const seats=frame?.round?.seat_identity?.verified?frame.round.seat_identity.seats:null;
 if(seats){
  for(const p of GAME.positions){
   if(frame.rivers?.[p]?.tiles?.some(t=>t.sideways===true)&&Number.isInteger(seats[p]))riichi.add(seats[p]);
  }
 }

 const frameMelds=GAME.positions.flatMap(p=>(p==='self'?frame?.own_melds:frame?.opponent_melds?.[p])?.groups??[]);
 const frameKans=frameMelds.filter(g=>['GANG','ANGANG','BUGANG'].includes(g.kind)).length;
 let historyKans=0,historyNorth=0,historyOwnKita=0,historyWind=null,hasOpenMeldInHistory=false;
 let sawRoundStart=false,sawOpeningHand=false,historyExact=true,historyDraws=0;
 const historyDiscards=new Map(GAME.seats.map(s=>[s,[]]));
 const ownHistoryDiscards=[];
 const historyMeldsBySeat=new Map(GAME.seats.map(s=>[s,[]]));
 let lastDiscardRef=null;
 for(const r of history??[]){
  if(r?.historyOrderCertain===false||r?.estimated===true)historyExact=false;
  if(typeof r?.handTiles==='string'&&r.handTiles.trim().startsWith('1 '))sawOpeningHand=true;
  const w=(r?.state??'').trim().split(/\s+/);
  if(w[0]==='0'){
   historyKans=0;historyNorth=0;historyOwnKita=0;lastDiscardRef=null;hasOpenMeldInHistory=false;
   sawRoundStart=true;sawOpeningHand=false;historyExact=true;historyDraws=0;
   ownHistoryDiscards.length=0;
   historyWind=Number.isInteger(Number(w[2]))?Number(w[2]):null;
   for(const s of GAME.seats){historyDiscards.set(s,[]);historyMeldsBySeat.set(s,[]);}
   continue;
  }
  if(w[0]==='2'){historyDraws++;continue;}
  if(w[0]!=='3')continue;
  const actor=Number(w[1]),kind=w[2];
  if(kind==='DRAW'){historyDraws++;continue;}
  if(actor===seat&&['CHI','PENG','GANG','BUGANG'].includes(kind))hasOpenMeldInHistory=true;
  if(['GANG','ANGANG','BUGANG'].includes(kind))historyKans++;
  if(kind==='KITA'){historyNorth++;if(actor===seat)historyOwnKita++;}
  if(['CHI','PENG','GANG'].includes(kind)&&lastDiscardRef){
   const arr=historyDiscards.get(lastDiscardRef.seat);
   if(arr?.length)arr.pop();
   lastDiscardRef=null;
  }
  if(kind==='PLAY'||kind==='LIZHI'){
   if(w[3]&&historyDiscards.has(actor)){
    historyDiscards.get(actor).push(w[3]);
    if(actor===seat)ownHistoryDiscards.push(w[3]);
    lastDiscardRef={seat:actor,tile:w[3]};
   }
  }else if(kind==='CHI'||kind==='PENG'){
   if(w.length>=6&&historyMeldsBySeat.has(actor))historyMeldsBySeat.get(actor).push({kind,tiles:w.slice(3,6)});
   if(w.length===7&&historyDiscards.has(actor)){
    historyDiscards.get(actor).push(w[6]);
    if(actor===seat)ownHistoryDiscards.push(w[6]);
    lastDiscardRef={seat:actor,tile:w[6]};
   }
  }else if((kind==='GANG'||kind==='ANGANG')&&w[3]&&historyMeldsBySeat.has(actor)){
   historyMeldsBySeat.get(actor).push({kind,tiles:[w[3],w[3],w[3],w[3]]});
  }else if(kind==='BUGANG'&&w[3]&&historyMeldsBySeat.has(actor)){
   const target=historyMeldsBySeat.get(actor).find(m=>m.kind==='PENG'&&normTile(m.tiles[0])===normTile(w[3]));
   if(target){target.kind='BUGANG';target.tiles=[...target.tiles,w[3]];}
   else historyMeldsBySeat.get(actor).push({kind:'BUGANG',tiles:[w[3],w[3],w[3],w[3]]});
  }
 }
 const extraDraw=event?.state?.trim().startsWith('2 ')&&(history?.at(-1)!==event)?1:0;
 const historyRemaining=sawRoundStart&&sawOpeningHand&&historyExact
  ?Math.max(0,GAME.initialWall-historyDraws-extraDraw):null;
 const kans=Math.max(frameKans,historyKans);
 const frameNorth=GAME.sanma?GAME.positions.reduce((n,p)=>n+(frame?.kita?.[p]?.count??0),0):0;
 const northCount=GAME.sanma?Math.max(frameNorth,historyNorth):0;
 const ownKitaCount=GAME.sanma?Math.max(frame?.kita?.self?.count??0,historyOwnKita):0;

 const doraIndicators=parseDoraIndicators(event,frame,history);
 const wind=Number.isInteger(frame?.round?.wind)?frame.round.wind:historyWind;

 // Build visible tile counts and seen red fives without double-counting.
 const visibleCounts=Array(34).fill(0);
 const seenReds=new Set();
 const addTile=t=>{
  const code=typeof t==='object'?t?.tile:t;
  const idx=tileIndex(code);
  if(idx>=0)visibleCounts[idx]++;
  if(isRedFive(code))seenReds.add(code[0]);
 };
 for(const t of hand)addTile(t);
 for(const m of ownMelds)for(const t of m.tiles??[])addTile(t);
 for(const ind of doraIndicators)addTile(ind);
 if(GAME.sanma&&northCount>0)visibleCounts[tileIndex('Z4')]+=northCount;

 for(const p of GAME.positions){
  const seatForPos=seats?seats[p]:(Number.isInteger(seat)?(p==='self'?seat:(seat+GAME.relativeOffset[p])%GAME.players):null);
  if(Array.isArray(frame?.rivers?.[p]?.tiles)){
   for(const t of frame.rivers[p].tiles)addTile(t);
  }else if(Number.isInteger(seatForPos)){
   for(const t of historyDiscards.get(seatForPos)??[])addTile(t);
  }
  if(p!=='self'){
   if(Array.isArray(frame?.opponent_melds?.[p]?.groups)){
    for(const g of frame.opponent_melds[p].groups)for(const t of g.tiles??[])addTile(t);
   }else if(Number.isInteger(seatForPos)){
    for(const g of historyMeldsBySeat.get(seatForPos)??[])for(const t of g.tiles??[])addTile(t);
   }
  }
 }

 // Preserve called-away own discards so furiten detection stays exact.
 const ownDiscards=[
  ...ownHistoryDiscards,
  ...((frame?.rivers?.self?.tiles??[]).map(t=>typeof t==='object'?t.tile:t)),
 ];

 return {riichi,kans,northCount,ownKitaCount,doraIndicators,wind,visibleCounts,seenReds,ownDiscards,hasOpenMeldInHistory,historyRemaining};
}

function permitted(response,actions,policy={}){
 const parts=response.trim().split(/\s+/);
 const [kind,tile]=parts;
 if(kind==='HU'||kind==='TSUMO'||kind==='RONG'||kind==='GANG'||kind==='KYUSHU')return false;
 if(kind==='CHI'||kind==='PENG'){
  if(!actions.some(a=>kindOf(a)===kind))return false;
  if(parts.length!==4&&parts.length!==5)return false;
  const [,called,a,b,discard]=parts;
  if(policy.calledTile&&called!==policy.calledTile)return false;
  if(Array.isArray(policy.hand)){
   const combos=callCombinations(policy.hand,kind,called);
   if(!combos.some(pair=>samePair(pair,[a,b])))return false;
   if(discard){
    const after1=removeOnce(policy.hand,a);
    const after2=after1?removeOnce(after1,b):null;
    if(!after2||!after2.includes(discard))return false;
    if(kuikaeForbidden(kind,called,[a,b]).has(normTile(discard)))return false;
   }
  }
  return true;
 }
 const matched=actions.some(action=>{
  const [k,...tiles]=action.split(/\s+/);
  return k===kind&&(!tiles.length||tiles.includes(tile)||(isKan(k)&&tiles.some(x=>normTile(x)===normTile(tile))));
 });
 if(!matched)return false;
 if((kind==='PLAY'||kind==='LIZHI')&&Array.isArray(policy.hand)&&!policy.hand.includes(tile))return false;
 return true;
}

export function decisionPolicy(event,context,seat,frame,history,hand,route){
 const stateWords=(event.state??'').trim().split(/\s+/);
 const ownDraw=stateWords[0]==='2';
 const postCallDiscard=event.observedCallBeforeDiscard===true;
 const reaction=!ownDraw&&!postCallDiscard;

 let actions=(event.validact??'').split(',').map(a=>a.trim()).filter(Boolean);
 actions=actions.filter(a=>{
  const k=kindOf(a);
  if(k==='KYUSHU'||k==='GANG'||k==='HU'||k==='TSUMO'||k==='RONG')return false;
  if(!GAME.sanma&&k==='KITA')return false;
  if(GAME.sanma&&k==='CHI')return false;
  return true;
 });
 const ownPassFallback=ownDraw&&actions.some(a=>kindOf(a)==='PASS')&&!actions.some(a=>kindOf(a)==='PLAY');
 if(route)actions=route.filter(actions,hand,event);

 const {known:ownMeldsKnown,groups:ownMelds}=resolveOwnMelds(frame,history,seat);
 const facts=collectPublicFacts(event,frame,history,hand,ownMelds,seat);
 const {riichi,kans,northCount,ownKitaCount,doraIndicators,wind,visibleCounts,seenReds,ownDiscards,hasOpenMeldInHistory,historyRemaining}=facts;
 const locked=riichi.has(seat);
 const isClosed=!(ownMelds.some(m=>m.kind!=='ANGANG')||hasOpenMeldInHistory);
 let rest=null,restExact=false;
 if(Number.isInteger(frame?.round?.remaining?.value)){
  rest=frame.round.remaining.value;
  restExact=frame.round.remaining.estimated!==true;
 }else if(Number.isInteger(event.remaining)){
  rest=event.remaining;
  restExact=true;
 }else if(Number.isInteger(historyRemaining)){
  rest=historyRemaining;
  restExact=true;
 }
 const stockUsed=kans+northCount;
 let calledTile=null;
 let kanReferenceShanten=null;
 const kanAfterShanten=new Map();

 if(postCallDiscard){
  const callKind=stateWords[2];
  calledTile=stateWords[3]??null;
  const supplied=stateWords.slice(4,6);
  const forbidden=calledTile?kuikaeForbidden(callKind,calledTile,supplied):new Set();
  actions=actions.flatMap(a=>{
   if(kindOf(a)!=='PLAY')return [];
   const listed=a.split(/\s+/).slice(1);
   const allowed=[...new Set(hand)].filter(t=>!forbidden.has(normTile(t))&&(!listed.length||listed.includes(t)));
   return allowed.length?['PLAY '+allowed.join(' ')]:[];
  });
 }else if(reaction){
  const actor=Number(stateWords[1]);
  const triggerKind=stateWords[2];
  calledTile=['PLAY','LIZHI','BUGANG','KITA'].includes(triggerKind)?stateWords[3]:
   (['CHI','PENG'].includes(triggerKind)&&stateWords.length===7?stateWords[6]:null);
  const isCallDiscard=['PLAY','LIZHI','CHI','PENG'].includes(triggerKind)&&!!calledTile;
  const callBlocked=locked||(Number.isInteger(rest)&&rest<=0)||actor===seat||!isCallDiscard;
  const upstream=(seat+GAME.players-1)%GAME.players;
  actions=actions.filter(a=>{
   const k=kindOf(a);
   if(k==='CHI'){
    if(callBlocked||GAME.sanma||actor!==upstream||calledTile.startsWith('Z'))return false;
    return callCombinations(hand,'CHI',calledTile).length>0;
   }
   if(k==='PENG'){
    if(callBlocked)return false;
    return callCombinations(hand,'PENG',calledTile).length>0;
   }
   return k==='PASS';
  });
 }else if(ownDraw){
  const draw=stateWords[1];
  const scores=currentScores(context,frame,history);

  // On own draw turns, abandoning riichi/kan/kita means choosing a concrete discard.
  // Keep PASS only when PASS is the sole remaining action (e.g. KYUSHU,PASS).
  const hadOnlyPass=actions.length>0&&actions.every(a=>kindOf(a)==='PASS');
  if(!hadOnlyPass)actions=actions.filter(a=>!['PASS','CHI','PENG','RONG'].includes(kindOf(a)));

  // 拔北 (Sanma only)
  if(GAME.sanma){
   const kitaAllowed=hand.includes('Z4')&&!(Number.isInteger(rest)&&rest<1)&&stockUsed<8&&(!locked||draw==='Z4');
   actions=actions.flatMap(a=>{
    if(kindOf(a)!=='KITA')return [a];
    return kitaAllowed?['KITA Z4']:[];
   });
  }

  // 暗杠 / 加杠 (both non-riichi and post-riichi rules)
  if(actions.some(a=>isKan(kindOf(a)))){
   if(locked){
    actions=actions.flatMap(a=>{
     const k=kindOf(a);
     if(k==='BUGANG')return [];
     if(k!=='ANGANG')return [a];
     if((Number.isInteger(rest)&&rest<1)||kans>=4||(GAME.sanma&&stockUsed>=8))return [];
     if(!draw)return [];
     const drawNorm=normTile(draw);
     const listed=a.split(/\s+/).slice(1);
     if(listed.length&&!listed.some(t=>normTile(t)===drawNorm))return [];
     const fourCopies=hand.filter(t=>normTile(t)===drawNorm);
     if(fourCopies.length!==4)return [];
     if(!GAME.sanma){
      if(!ownMeldsKnown||hand.length!==14-3*ownMelds.length)return [];
      const beforeHand=removeOnce(hand,draw);
      const beforeWaits=beforeHand?shapeWaits(beforeHand,ownMelds):null;
      const afterHand=hand.filter(t=>normTile(t)!==drawNorm);
      const afterWaits=shapeWaits(afterHand,[...ownMelds,{kind:'ANGANG',tiles:fourCopies}]);
      if(!beforeWaits?.length||!afterWaits?.length||beforeWaits.length!==afterWaits.length||
         beforeWaits.some((w,i)=>w!==afterWaits[i]))return [];
     }
     const kanTile=fourCopies.includes(drawNorm)?drawNorm:fourCopies[0];
     return ['ANGANG '+kanTile];
    });
   }else{
    const globalKanAllowed=Number.isInteger(rest)&&rest>=5&&kans<3&&riichi.size===0&&
     (!GAME.sanma||stockUsed<8)&&ownMeldsKnown&&hand.length===14-3*ownMelds.length;
    let referenceShanten=null;
    if(globalKanAllowed){
     let best=Infinity;
     for(const t of new Set(hand)){
      const after=removeOnce(hand,t);
      const sh=after?computeShanten(after,ownMelds):null;
      if(!Number.isInteger(sh)){best=null;break;}
      if(sh<best)best=sh;
     }
     if(Number.isInteger(best)&&best>=0&&best<=2){
      referenceShanten=best;
      kanReferenceShanten=best;
     }
    }
    actions=actions.flatMap(a=>{
     const k=kindOf(a);
     if(!isKan(k))return [a];
     if(referenceShanten===null)return [];
     const listed=a.split(/\s+/).slice(1);
     const listedNorms=new Set(listed.map(normTile));
     if(k==='ANGANG'){
      const byNorm=new Map();
      for(const t of hand){const n=normTile(t);(byNorm.get(n)??byNorm.set(n,[]).get(n)).push(t);}
      const allowed=[];
      for(const [n,copies] of byNorm){
       if(copies.length!==4)continue;
       if(listed.length&&!listedNorms.has(n))continue;
       const afterHand=hand.filter(t=>normTile(t)!==n);
       const afterSh=computeShanten(afterHand,[...ownMelds,{kind:'ANGANG',tiles:copies}]);
       if(Number.isInteger(afterSh)&&afterSh>=0&&afterSh<=referenceShanten){
        kanAfterShanten.set(n,afterSh);
        allowed.push(copies.includes(n)?n:copies[0]);
       }
      }
      return allowed.length?['ANGANG '+allowed.join(' ')]:[];
     }
     // BUGANG: requires existing PENG + 4th copy in hand; preserve physical tile (e.g. W0)
     // and evaluate shanten against the upgraded 4-tile BUGANG meld so owned[tile]===4 is exact.
     const allowed=[];
     const seenNorm=new Set();
     for(const m of ownMelds){
      if(m.kind!=='PENG'||!m.tiles?.length)continue;
      const n=normTile(m.tiles[0]);
      if(seenNorm.has(n)||(listed.length&&!listedNorms.has(n)))continue;
      const phys=hand.find(t=>normTile(t)===n);
      if(!phys)continue;
      const afterHand=removeOnce(hand,phys);
      const afterMelds=ownMelds.map(x=>x===m?{...x,kind:'BUGANG',tiles:[...x.tiles,phys]}:x);
      const afterSh=afterHand?computeShanten(afterHand,afterMelds):null;
      if(Number.isInteger(afterSh)&&afterSh>=0&&afterSh<=referenceShanten){
       seenNorm.add(n);
       kanAfterShanten.set(n,afterSh);
       allowed.push(phys);
      }
     }
     return allowed.length?['BUGANG '+allowed.join(' ')]:[];
    });
   }
  }

  // 立直: 基本资格 + 逐张听牌 + 逐张默听役满排除 (末局规则紧接在 restrictEndgameRiichi 中执行)
  // 三麻摸牌回合始终禁止弃北风（含普通弃牌与立直宣言牌），只接受拔北。
  const forbidNorthDiscard=GAME.sanma;
  const riichiBaseEligible=!locked&&isClosed&&!(Number.isInteger(rest)&&rest<GAME.players)&&!(scores&&scores[seat]<1000)&&!route?.active;
  actions=actions.flatMap(a=>{
   const k=kindOf(a);
   if(k!=='LIZHI')return [a];
   if(!riichiBaseEligible||!ownMeldsKnown||hand.length!==14-3*ownMelds.length)return [];
   const listed=a.split(/\s+/).slice(1);
   const candidates=[...new Set(hand)].filter(t=>(!forbidNorthDiscard||t!=='Z4')&&(!listed.length||listed.includes(t)));
   const allowed=candidates.filter(tile=>{
    const after=removeOnce(hand,tile);
    if(!after||!(shapeWaits(after,ownMelds)?.length>0))return false;
    const cap=evaluateDamaRiichiCap(hand,tile,ownMelds,{
     seat,wind,doraIndicators,visibleCounts,seenReds,ownDiscards,remaining:rest,remainingExact:restExact,ownKitaCount,sanma:GAME.sanma,
    });
    return !cap.blocked;
   });
   return allowed.length?['LIZHI '+allowed.join(' ')]:[];
  });

  if(locked)actions=actions.filter(a=>['PLAY','KITA','ANGANG'].includes(kindOf(a)));

  // 弃牌: 只能打手中实际持有的牌；立直后只可摸切；三麻摸牌回合始终排除北风
  // 仅在极端强制摸切边界（无 KITA 且剔除 Z4 后没有任何其他合法动作）保留 PLAY Z4 防崩溃兜底。
  let fallbackPlayNorth=false;
  actions=actions.flatMap(a=>{
   if(kindOf(a)!=='PLAY')return [a];
   const listed=a.split(/\s+/).slice(1);
   const base=locked?(hand.includes(draw)?[draw]:[]):[...new Set(hand)];
   const rawAllowed=base.filter(t=>!listed.length||listed.includes(t));
   const allowed=forbidNorthDiscard?rawAllowed.filter(t=>t!=='Z4'):rawAllowed;
   if(!allowed.length&&forbidNorthDiscard&&rawAllowed.includes('Z4'))fallbackPlayNorth=true;
   return allowed.length?['PLAY '+allowed.join(' ')]:[];
  });
  if(!actions.length&&fallbackPlayNorth)actions=['PLAY Z4'];
 }

 let request=restrictEndgameRiichi({...event,validact:actions.join(',')},context,seat,frame,history,{
  hand,
  ownMelds:ownMeldsKnown?ownMelds:[],
  wind,
  visibleCounts,
 });
 if(ownPassFallback&&!request.validact)request={...request,validact:'PASS'};
 return {request,locked,isClosed,hand:[...hand],calledTile,kanReferenceShanten,kanAfterShanten};
}

export function selectDecision(output,policy){
 const {request,locked}=policy;
 const actions=(request.validact??'').split(',').map(a=>a.trim()).filter(Boolean);
 const ranked=output.decision_options?.ranked;
 if(output.decision_options?.schema!==1||!Array.isArray(ranked))throw invalid();
 const playShantens=ranked.filter(r=>r.response?.startsWith('PLAY ')&&Number.isInteger(r.shanten)).map(r=>r.shanten);
 const minPlayShanten=playShantens.length?Math.min(...playShantens):null;
 const row=ranked.find(r=>{
  if(typeof r.response!=='string'||!permitted(r.response,actions,policy))return false;
  const k=kindOf(r.response);
  if(k==='LIZHI'){
   if(r.dama_capped_no_gain===true)return false;
   const tile=r.response.trim().split(/\s+/)[1];
   const exempt=Array.isArray(request.endgameRiichiExemptTiles)&&request.endgameRiichiExemptTiles.includes(tile);
   if(!exempt&&request.minimumRiichiWinProbability!=null&&
      !(Number.isFinite(r.win_probability)&&r.win_probability>=request.minimumRiichiWinProbability))return false;
  }
  if(isKan(k)&&!locked){
   const facts=r.kan_policy;
   if(facts&&(facts.remaining_live_tiles<5||facts.opponent_riichi||facts.declared_kans>=3))return false;
   const kanTile=normTile(r.response.trim().split(/\s+/)[1]);
   const baseline=Number.isInteger(policy.kanReferenceShanten)?policy.kanReferenceShanten:(facts?.reference_shanten??minPlayShanten);
   const after=policy.kanAfterShanten?.has(kanTile)?policy.kanAfterShanten.get(kanTile):(facts?.kan_shanten??r.shanten);
   return Number.isInteger(baseline)&&baseline>=0&&baseline<=2&&Number.isInteger(after)&&after>=0&&after<=baseline;
  }
  return true;
 });
 if(!row)throw invalid();
 return row;
}
