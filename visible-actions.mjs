import {GAME} from './game-rules.mjs';
import {shapeWaits} from './tenpai-hint.mjs';
import {currentScores} from './endgame-riichi.mjs';
import {declaredSeats} from './confirmed-riichi.mjs';

const norm=t=>typeof t==='string'&&t.endsWith('0')?t[0]+'5':t;

function tableStockCounts(frame,history){
 const frameMelds=GAME.positions.flatMap(p=>(p==='self'?frame?.own_melds:frame?.opponent_melds?.[p])?.groups??[]);
 const frameKans=frameMelds.filter(g=>['GANG','ANGANG','BUGANG'].includes(g.kind)).length;
 let historyKans=0,historyNorth=0;
 for(const r of history??[]){
  const w=(r?.state??'').trim().split(/\s+/);
  if(w[0]==='0'){historyKans=0;historyNorth=0;continue;}
  if(w[0]!=='3')continue;
  if(['GANG','ANGANG','BUGANG'].includes(w[2]))historyKans++;
  if(w[2]==='KITA')historyNorth++;
 }
 const kans=Math.max(frameKans,historyKans);
 const frameNorth=GAME.sanma?GAME.positions.reduce((n,p)=>n+(frame?.kita?.[p]?.count??0),0):0;
 const northCount=GAME.sanma?Math.max(frameNorth,historyNorth):0;
 return {kans,northCount,stockUsed:kans+northCount};
}

// Retained for compatibility with diagnostics/tests; own-draw decision flow no longer blocks on missing controls.
export function missingRiichiOffer(frame,session){
 const c=frame.controls??{},stock=frame.round?.remaining;
 if(c.LIZHI||c.HU||c.TSUMO||frame.selection?.verified||!frame.hand?.complete||
    frame.hand.rejected?.length||!frame.own_melds?.complete)return false;
 const melds=frame.own_melds.groups,hand=frame.hand.tiles.map(t=>t.tile);
 if(hand.length!==14-3*melds.length||melds.some(m=>m.kind!=='ANGANG')||
    frame.round?.turn?.position&&frame.round.turn.position!=='self')return false;
 const remaining=stock?.estimated?stock.observedValue:stock?.value;
 if(!Number.isInteger(remaining)||remaining<GAME.players||
    declaredSeats(session.requests).has(session.seat)||frame.rivers?.self?.tiles?.some(t=>t.sideways))return false;
 const points=currentScores(session.context,frame,session.requests)?.[session.seat];
 if(!Number.isInteger(points)||points<1000)return false;
 return [...new Set(hand)].some(tile=>{
  const rest=hand.slice();rest.splice(rest.indexOf(tile),1);
  return shapeWaits(rest,melds)?.length>0;
 });
}

// Derive legal post-riichi concealed kong directly from hand/melds/wall state (independent of controls).
export function riichiKongTile(frame,history=null){
  const h=frame?.hand,m=frame?.own_melds;
  if(!h?.complete||h.rejected?.length||!m?.complete||h.tiles.length!==14-3*m.groups.length)return null;
  const rest=frame.round?.remaining?.value;
  if(Number.isInteger(rest)&&rest<1)return null;
  const {kans,stockUsed}=tableStockCounts(frame,history);
  if(kans>=4||(GAME.sanma&&stockUsed>=8))return null;
  const hand=h.tiles.map(t=>t.tile);
  const draw=norm(hand.at(-1));
  const fourCopies=hand.filter(t=>norm(t)===draw);
  if(fourCopies.length!==4)return null;
  if(!GAME.sanma){
    const beforeHand=hand.slice(0,-1);
    const beforeWaits=shapeWaits(beforeHand,m.groups);
    const afterHand=hand.filter(t=>norm(t)!==draw);
    const afterWaits=shapeWaits(afterHand,[...m.groups,{kind:'ANGANG',tiles:fourCopies}]);
    if(!beforeWaits?.length||!afterWaits?.length||beforeWaits.length!==afterWaits.length||
       beforeWaits.some((w,i)=>w!==afterWaits[i]))return null;
  }
  return draw;
}

// In passive riichi mode, wake decision flow only for post-riichi ANGANG or Sanma KITA.
// Winning is always handled by in-game auto-win (never sent to the decision engine).
export function riichiDecisionPrompt(frame,session=null,adapter=null){
  const h=frame?.hand,m=frame?.own_melds;
  if(!h?.complete||h.rejected?.length||!m?.complete||h.tiles.length!==14-3*m.groups.length)return false;
  const history=session?.requests??null;
  if(riichiKongTile(frame,history))return true;
  if(GAME.sanma){
    const autoKitaOn=!!((frame.auto_kita?.verified&&frame.auto_kita.enabled)||adapter?.autoKitaOutput?.requested||adapter?.autoKitaOutput?.confirmed);
    if(!autoKitaOn&&h.tiles.at(-1)?.tile==='Z4'){
      const rest=frame.round?.remaining?.value;
      const {stockUsed}=tableStockCounts(frame,history);
      if(!(Number.isInteger(rest)&&rest<1)&&stockUsed<8)return true;
    }
  }
  return false;
}

// Own draws derive all physically possible non-win actions directly from hand/melds/table state
// (independent of frame.controls), then decisionPolicy() filters to the exact legal action set.
// Opponent reactions retain frame.controls button detection for PASS / PENG / (Yonma CHI) only;
// winning (TSUMO/RONG/HU) is never sent to the decision engine.
export function visibleActions(frame,event,melds,{riichi=false,history=null}={}){
  if(!frame.hand?.complete)throw Error('Complete visible hand required');
  const controls=frame.controls??{},own=event.state?.trim().startsWith('2 ');
  const actions=[];
  if(own){
    const ownMelds=Array.isArray(melds)?melds:(frame.own_melds?.complete===false?null:(frame.own_melds?.groups??[]));
    const tiles=frame.hand.tiles.map(t=>t.tile);
    actions.push('PLAY');
    if(!Array.isArray(ownMelds)||!ownMelds.some(m=>m.kind!=='ANGANG'))actions.push('LIZHI');
    if(GAME.sanma&&tiles.includes('Z4'))actions.push('KITA Z4');
    const counts=new Map();
    for(const tile of tiles)counts.set(norm(tile),(counts.get(norm(tile))??0)+1);
    const closed=[...counts].filter(([,n])=>n===4).map(([t])=>t);
    if(closed.length)actions.push('ANGANG '+closed.join(' '));
    if(Array.isArray(ownMelds)){
      const added=ownMelds.filter(m=>m.kind==='PENG'&&m.tiles?.length).map(m=>tiles.find(t=>norm(t)===norm(m.tiles[0]))).filter(Boolean);
      if(added.length)actions.push('BUGANG '+[...new Set(added)].join(' '));
    }
  }else{
    if(!/^3 [0-3] (PLAY|LIZHI|CHI|PENG|BUGANG|KITA) /.test(event.state??''))throw Error('Reaction requires a public discard or added kong');
    if(!controls.PASS)throw Error('Reaction window is not visible');
    actions.push('PASS');
    for(const name of GAME.sanma?['PENG']:['CHI','PENG'])if(controls[name])actions.push(name);
  }
  return {...event,validact:actions.join(',')};
}
