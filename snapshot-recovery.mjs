import {roundIdentity} from './round-boundary.mjs';
import {preserveRiichi} from './confirmed-riichi.mjs';
import {assertOpeningIntegrity} from './opening-integrity.mjs';
import {canonicalMelds} from './meld-events.mjs';
import {estimateWall,fillWall} from './wall-estimate.mjs';
import {hasNoCalls,retainedRivers,mergeKnownRiver,exactNoCallOrder} from './recovery-order.mjs';
const positions=['self','right','opposite','left'];
// User-authorized estimated history. This is deliberately NOT verified history.
export function snapshotRecovery(frame,{previous=null,history=[]}={}){
 assertOpeningIntegrity(frame);
 if(hasNoCalls(frame)&&positions.every(p=>!(frame.rivers?.[p]?.tiles?.length))&&
    positions.some(p=>!frame.rivers?.[p]?.complete))throw Error('Opening river recognition incomplete; retry current frame');
 const r=roundIdentity(frame);if(!r||!frame.hand?.complete||!frame.dora?.complete)throw Error('Snapshot hand/round/dora incomplete');
 const hand=frame.hand.tiles.map(t=>t.tile),melds={},rivers={},extraAssumptions=[];
 if(frame.own_melds?.estimated)extraAssumptions.push('自家暗杠按已请求动作、两张可见牌面和手牌移除证据恢复，未冒充点击确认');
 const sameRound=previous&&JSON.stringify(roundIdentity(previous))===JSON.stringify(r);
 for(const p of positions){
  rivers[p]=structuredClone(frame.rivers?.[p]?.tiles??[]);
  const observed=p==='self'?frame.own_melds:frame.opponent_melds?.[p];
  if(p==='self'||observed?.complete)melds[p]=canonicalMelds(frame,p,observed);
  else{
   const old=sameRound?previous.opponent_melds?.[p]:null;
   melds[p]=old?.complete?canonicalMelds(previous,p,old):[];
   extraAssumptions.push(`${p}副露暂未读全，沿用同局已知副露或暂按无副露`);
  }
 }
 if(hasNoCalls(frame)){
  const retained=retainedRivers(history);
  for(const p of positions){
   let known=retained[r.seats[p]];
   if(sameRound)known=mergeKnownRiver(known,previous.rivers?.[p]?.tiles??[]);
   rivers[p]=mergeKnownRiver(known,rivers[p]);
  }
 }
 const own=hand.length===14-3*melds.self.length;
 if(!own&&hand.length!==13-3*melds.self.length)throw Error('Snapshot hand count inconsistent');
 let remaining=frame.round.remaining?.value;
 if(!Number.isInteger(remaining)||remaining<0||remaining>69){
  const old=sameRound?previous.round.remaining?.value:null;
  remaining=estimateWall(frame)??(Number.isInteger(old)?Math.max(0,Math.min(69,old)):Math.max(0,69-Object.values(rivers).reduce((n,a)=>n+a.length,0)));
  fillWall(frame,remaining,'snapshot-visible-tiles');
  extraAssumptions.push('余牌暂未读清，按可见牌估计并同步衔接基准');
 }
 let event=own?{state:`2 ${hand.at(-1)}`,validact:null}:null;
 const ordered=exactNoCallOrder(frame,rivers,remaining,own);
 if(!own&&frame.controls?.PASS){
  const candidates=positions.filter(p=>p!=='self'&&rivers[p].length);
  const p=candidates.includes(frame.round.turn?.position)?frame.round.turn.position:candidates.sort((a,b)=>rivers[b].length-rivers[a].length)[0];
  if(!p)throw Error('Current reaction tile not yet readable');
  const t=rivers[p].pop();event={state:`3 ${r.seats[p]} ${t.sideways?'LIZHI':'PLAY'} ${t.tile}`,validact:null,historyOrderCertain:false};
 }
 const requests=[{state:`0 ${r.seats.self} ${r.wind}`,validact:null}];
 const emit=(seat,action)=>requests.push({state:`3 ${seat} ${action}`,validact:null,historyOrderCertain:false});
 // Feed enough disposable own tiles for replay. A final handTiles checkpoint
 // replaces this synthetic hand; it does not clear the bot's public state.
 const supply=[...hand];
 for(const t of rivers.self)supply.push(t.tile);
 for(const m of melds.self)supply.push(...m.tiles);
 requests.push({handTiles:`1 ${supply.join(' ')}`,doraIndicators:frame.dora.tiles.map(t=>t.tile).join(' '),validact:null});
 if(ordered&&(own||!event||ordered.at(-1)?.state===event.state)){
  if(!own&&event)event=ordered.pop();
  requests.push(...ordered);
  const initialHand=own?hand.slice(0,-1):hand;
  requests.push({handTiles:`1 ${initialHand.join(' ')}`,doraIndicators:frame.dora.tiles.map(t=>t.tile).join(' '),validact:null});
  return {requests:preserveRiichi(history,requests),event,seat:r.seats.self,hand:initialHand,frameId:frame.id,estimated:true,chronologyCertain:true,
   assumptions:['无副露，按各家累计弃牌序号和座次恢复确定顺序；余牌数已核对','保留已有弃牌记录；未知摸切标记仍按手切']};
 }
 // Place calls early and use each caller's earliest remaining visible discard.
 // Called tiles are absent from the visible river, but belong in protocol history.
 for(const p of positions)for(const m of melds[p]){
  const actor=r.seats[p];
  if(m.kind==='ANGANG'){emit(actor,`ANGANG ${m.tiles[0]}`);continue;}
  const called=m.tiles[m.calledIndex];emit(m.from,`PLAY ${called}`);
  if(['GANG','BUGANG'].includes(m.kind)){emit(actor,`GANG ${called}`);continue;}
  let discard=rivers[p].shift();
  if(!discard){discard={tile:'Z1'};extraAssumptions.push(`${p}鸣牌后的历史弃牌不可见，使用东占位；当前手牌随后重新载入`);}
  const own=[...m.tiles];own.splice(m.calledIndex,1);
  emit(actor,`${m.kind} ${called} ${own.join(' ')} ${discard.tile}`);
 }
 // Interleave the remaining rivers by seat; exact cross-player chronology is unknown.
 let index=0;
 while(positions.some(p=>index<rivers[p].length)){
  for(let seat=0;seat<4;seat++){
   const p=positions.find(p=>r.seats[p]===seat),t=rivers[p][index];
   if(t)emit(seat,`${t.sideways?'LIZHI':'PLAY'} ${t.tile}`);
  }
  index++;
 }
 // Match visible wall count. Historical draw ownership is an explicit estimate.
 for(let i=0;i<70-remaining-(own?1:0);i++)emit(i%4,'DRAW');
 const initialHand=own?hand.slice(0,-1):hand;
 requests.push({handTiles:`1 ${initialHand.join(' ')}`,doraIndicators:frame.dora.tiles.map(t=>t.tile).join(' '),validact:null});
 return {requests:preserveRiichi(history,requests),event,seat:r.seats.self,hand:initialHand,frameId:frame.id,
  estimated:true,assumptions:[...extraAssumptions,'跨玩家动作顺序按座次交错估计','鸣牌时点前置；加杠按明杠恢复','历史摸牌归属均分估计；摸切标记按手切','未识别的旧弃牌暂不计入可见牌；反应对象按当前轮转和牌河估计','已放过的和牌机会未知；仅执行当前界面允许的动作']};
}
