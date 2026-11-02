import {reportSavedScreenshot} from './screenshot-log.mjs';
import {reportMatchResult} from './match-result-log.mjs';
import {waitDetails} from './wait-details.mjs';
import {metricsText} from './decision-metrics.mjs';
import {roundIdentity} from './round-boundary.mjs';
const digits=['零','一','二','三','四','五','六','七','八','九'];
const honors=['','东','南','西','北','白','发','中'];
const positions={self:'自己',right:'下家',opposite:'对家',left:'上家'};
const actions={PLAY:'打出',PASS:'过',CHI:'吃',PENG:'碰',GANG:'明杠',ANGANG:'暗杠',BUGANG:'加杠',LIZHI:'立直',HU:'和牌',DRAW:'摸牌'};
export function tileName(value){
 const tile=typeof value==='object'?value?.tile:value;
 if(!tile)return '未识别';
 if(/^Z[1-7]$/.test(tile))return honors[Number(tile[1])];
 if(/^[WBT][0-9]$/.test(tile))return (tile[1]==='0'?'赤五':digits[Number(tile[1])])+({W:'万',B:'筒',T:'条'}[tile[0]]);
 return '未识别';
}
const tiles=a=>Array.isArray(a)?a.map(tileName).join(' '):'未识别';
export function callWaitNotice(event){
 return `鸣牌推断：${(event.candidate_positions??['opposite','right']).map(p=>positions[p]).join('或')}有≥2张${tileName(event.tile)}`;
}
export function actionName(value=''){
 const [kind,...args]=value.trim().split(/\s+/);
 if(['CHI','PENG'].includes(kind)&&args.length===4)return `${actions[kind]} ${tiles(args.slice(0,3))}；随后打出 ${tileName(args[3])}`;
 return `${actions[kind]??'未知动作'}${args.length?' '+tiles(args):''}`;
}
export function reactionTile(request){
 const words=(request?.state??'').trim().split(/\s+/);
 if(words[0]==='2')return words[1];
 if(words[0]!=='3')return null;
 if(['CHI','PENG'].includes(words[2]))return words.length===7?words[6]:null;
 return ['PLAY','LIZHI','BUGANG','GANG','ANGANG'].includes(words[2])?words[3]:null;
}
export function passContext(request){
 const tile=reactionTile(request);
 const allowed=new Set(String(request?.validact??'').split(/[,\s]+/));
 const choices=['CHI','PENG','GANG','HU','LIZHI'].filter(a=>allowed.has(a)).map(a=>actions[a]);
 if(choices.length)return `${choices.join('／')}${tile?' '+tileName(tile):''}`;
 return eventName(request)??'';
}
export function eventName(event){
 const [type,seat,kind,...args]=(event?.state??'').trim().split(/\s+/);
 const label=(tile,i)=>`${tileName(tile)}${event.recognitionScores?`(${Number.isFinite(event.recognitionScores[i])?Number(event.recognitionScores[i].toFixed(2)):'未评分'})`:''}`;
 if(type==='2')return `摸牌 ${label(seat,0)}`;
 if(type==='DORA')return `新增宝牌指示牌：${label(seat,0)}`;
 if(type!=='3'||! /^[0-3]$/.test(seat)||!actions[kind])return null;
 const who=['东家','南家','西家','北家'][Number(seat)];
 const mode=event.discardMode==='tedashi'||(['CHI','PENG'].includes(kind)&&args.length===4)?'手切':'摸切';
 const hasMode=!!event.discardMode&&!event.discardModeInferred||(['CHI','PENG'].includes(kind)&&args.length===4);
 const suffix=hasMode&&(['PLAY','LIZHI'].includes(kind)||(['CHI','PENG'].includes(kind)&&args.length===4))?` ${mode}`:'';
 if(kind==='ANGANG'){
  const shown=event.meldDisplayTiles??args;
  return `${who} 暗杠${shown.length?' '+shown.map((t,i)=>event.recognitionScores&&i<(event.visibleMeldFaceCount??0)?label(t,i):tileName(t)).join(' '):''}`;
 }
 if(event.recognitionScores&&args.length&&!['ANGANG','DRAW'].includes(kind)){
  if(['CHI','PENG'].includes(kind)&&args.length===4)return `${who} ${actions[kind]} ${args.slice(0,3).map(label).join(' ')}；随后打出 ${label(args[3],3)}${suffix}`;
  return `${who} ${actions[kind]} ${args.map(label).join(' ')}${suffix}`;
 }
 return `${who} ${kind==='DRAW'?'摸牌':actionName([kind,...args].join(' '))}${suffix}`;
}
const faceScore=t=>Number.isFinite(t?.score)?t.score:
 Number.isFinite(t?.recognition?.score)&&t?.color?.verified?
 Math.round((.9*t.recognition.score+10*Math.max(0,1-t.color.distance/.25))*100)/100:null;
export function scoredEvents(events,frame){
 const seats=frame?.round?.seat_identity?.seats??{};
 const pools={};
 for(const [position,seat] of Object.entries(seats))pools[seat]={
  river:[...(frame.rivers?.[position]?.tiles??[])],
  meld:[...(position==='self'?frame.meld_faces??[]:frame.opponent_meld_faces?.[position]?.tiles??[])]};
 const take=(pool,tile)=>{for(let i=pool.length-1;i>=0;i--)if(pool[i].tile===tile)return pool.splice(i,1)[0];return null;};
 return events.map(e=>({...e})).reverse().map(e=>{
  const [type,seat,kind,...args]=(e.state??'').split(/\s+/);
  if(type==='DORA'){
   const face=frame?.dora?.tiles?.[Number(kind)];e.recognitionScores=[face?.tile===seat?faceScore(face):null];
  }else if(type==='2'){
   const draw=frame?.hand?.tiles?.at(-1);e.recognitionScores=[draw?.tile===seat?faceScore(draw):null];
  }else if(type==='3'&&args.length){
   const p=pools[seat]??{river:[],meld:[]};
   if(kind==='ANGANG'){
    const normal=t=>t?.replace(/^([WBT])0$/,'$15');
    const faces=[];
    for(let i=0;i<p.meld.length&&faces.length<2;){
     if(normal(p.meld[i].tile)===normal(args[0]))faces.push(p.meld.splice(i,1)[0]);else i++;
    }
    const rest=args.length===4?[...args]:Array(4).fill(normal(args[0]));
    for(const f of faces){let i=rest.indexOf(f.tile);if(i<0)i=rest.findIndex(t=>normal(t)===normal(f.tile));if(i>=0)rest.splice(i,1);}
    e.meldDisplayTiles=[...faces.map(f=>f.tile),...rest];
    e.visibleMeldFaceCount=faces.length;
    e.recognitionScores=faces.map(faceScore);
    return e;
   }
   e.recognitionScores=args.map((t,i)=>{
    const discard=['PLAY','LIZHI'].includes(kind)||(['CHI','PENG'].includes(kind)&&i===3);
    const face=take(discard?p.river:p.meld,t);
    if(discard){
     // A discard after chi/pung comes from the concealed hand, not a draw.
     e.discardMode=['CHI','PENG'].includes(kind)?'tedashi':face?.discardMode??e.discardMode;
     e.discardModeInferred=face?.discardEvidence?.inferred??!e.discardMode;
    }
    return faceScore(face);
   });
  }
  return e;
 }).reverse();
}
const observed=(o,body)=>`${body}${o?.complete?'':'（识别未完整）'}`;
export function frameLines(f){
 const r=f.round??{},lines=[];
 lines.push(`局面：${Number.isInteger(r.wind)?honors[r.wind+1]:'未知场风'}${r.hand_number?.value??'?'}局 / ${r.counters?.honba??'?'}本场 / 供托 ${r.counters?.riichi_sticks??'?'} / 余牌 ${r.remaining?.value??'?'}`);
 lines.push(`手牌：${observed(f.hand,tiles(f.hand?.tiles))}`);
 lines.push(`宝牌指示牌：${observed(f.dora,tiles(f.dora?.tiles))}`);
 const meld=f.own_melds;
 const groups=meld?.groups?.map(g=>`${actions[g.kind]??'副露'}[${tiles(g.tiles)}]`).join('；');
 lines.push(`自己副露：${observed(meld,Array.isArray(meld?.groups)?groups||'无':'未识别')}`);
 if(f.settlement?.complete)lines.push('结算点数：'+Object.entries(positions).map(([p,n])=>`${n} ${f.settlement.scores?.[p]?.value??'未识别'}`).join(' / '));
 return lines;
}
const ms=n=>Number.isFinite(n)?`${n.toFixed(0)}毫秒`:'未记录';
export function discardWaits(frame,history,response,request){
 const [kind,...args]=response.trim().split(/\s+/);
 if(!['PLAY','LIZHI','CHI','PENG'].includes(kind))return undefined;
 if(!frame?.hand?.complete||!frame.own_melds?.complete)return null;
 const f=structuredClone(frame),h=structuredClone(history??{});
 f.round??={};
 if(Number.isInteger(h.wind))f.round.wind=h.wind;
 if(Number.isInteger(h.seat)){f.round.seat_identity??={seats:{}};f.round.seat_identity.seats??={};f.round.seat_identity.seats.self=h.seat;}
 const remove=tile=>{const i=f.hand.tiles.findLastIndex(t=>t.tile===tile);if(i<0)return false;f.hand.tiles.splice(i,1);return true;};
 if(['CHI','PENG'].includes(kind)){
  if(args.length!==4)return null;
  const called=reactionTile(request),owned=args.slice(0,3),i=owned.indexOf(called);
  if(i<0)return null;owned.splice(i,1);
  if(!owned.every(remove))return null;
  f.own_melds.groups.push({kind,tiles:args.slice(0,3)});
  // The called tile has moved from the river into our meld.
  const seat=Number((request.state??'').split(/\s+/)[1]);
  const pos=Object.keys(f.round?.seat_identity?.seats??{}).find(p=>f.round.seat_identity.seats[p]===seat);
  const river=f.rivers?.[pos]?.tiles;
  if(river?.at(-1)?.tile===called)river.pop();else return null;
 }
 const discard=args.at(-1);if(!remove(discard))return null;
 f.rivers??={};f.rivers.self??={complete:false,tiles:[]};f.rivers.self.tiles.push({tile:discard});
 h.discards=[...(h.discards??[]),discard];if(kind==='LIZHI')h.riichi=true;
 return waitDetails(f,h);
}
function waitsText(waits){
 if(waits===null)return '听牌：暂无法确认';
 if(!waits.length)return '听牌：未听牌';
 const describe=names=>names.length?names.map(a=>a.join('＋')).join(' 或 '):'无役';
 return '听牌：'+waits.map(w=>`${tileName(w.tile)}（荣和：${describe(w.ron)}；自摸：${describe(w.tsumo)}；剩余${w.remaining}张${w.furiten?'；'+w.furiten:''}${w.windsKnown?'':'；风位待确认'}）`).join('，');
}
export const logColors={opponent:94,draw:92,decision:96,tenpai:95,recovery:93,settlement:97,win:91,ptGain:91,ptLoss:31};
export function logCategory(text){
 if(/^和牌，/.test(text))return 'win';
 if(/^终局结算，|^终局结果：/.test(text)){
  const pt=/积分([+-]?\d+)/.exec(text);
  if(pt&&Number(pt[1])>0)return 'ptGain';
  if(pt&&Number(pt[1])<0)return 'ptLoss';
 }
 if(/^听牌[：提]/.test(text))return 'tenpai';
 if(/^摸牌 /.test(text))return 'draw';
 if(/^[东南西北]家 |^鸣牌推断：|^新增宝牌指示牌：/.test(text))return 'opponent';
 if(/^决策：|^操作已发送/.test(text))return 'decision';
 if(/^本局结算：/.test(text))return 'settlement';
 if(/^鸣牌未执行：/.test(text)||/恢复|重建|已修复局面历史顺序|异常|中断|未生效|失效|尚未确认|漏读|已降低搜索预算|请求动作已被替代/.test(text))return 'recovery';
 return null;
}
export class TerminalLog{
 constructor(write=s=>process.stdout.write(s),{color=process.env.NO_COLOR===undefined}={}){this.write=write;this.color=color;this.signature=null;this.lastLines=[];this.messages=new Map();}
 startRound(frame,{confirmed=true}={}){
  if(!frame?.hand?.complete||!frame.hand.tiles?.length)return;
  if(!roundIdentity(frame))return;
  const r=frame?.round,seat=r?.seat_identity?.seats?.self;
  if(!r?.seat_identity?.verified||!Number.isInteger(r.wind)||r.wind<0||r.wind>3||!Number.isInteger(seat)||seat<0||seat>3)return;
  const key=JSON.stringify([r.wind,r.hand_number?.value,r.counters?.honba,seat]);
  if(this.announcedRound===key){this.openingHand(frame);return;}
  if(this.announcedRound!==undefined&&!confirmed)return;
  this.announcedRound=key;
  this.lastLine=null;this.line(`${honors[r.wind+1]}${r.hand_number?.value??'?'}局 ${r.counters?.honba??'?'}本场 自风：${honors[seat+1]}`);
  this.openingHand(frame);
 }
 openingHand(frame){
  const h=frame?.hand,r=frame?.round;
  const key=JSON.stringify([r?.wind,r?.hand_number?.value,r?.counters?.honba]);
  if(this.printedOpeningHand===key)return;
  const reject=()=>{this.openingHandCandidate=null;};
  if(!h?.complete||h.outline_verified===false||h.rejected?.length||!r?.seat_identity?.verified)return reject();
  if(frame.rivers?.self?.tiles?.length||frame.own_melds?.melds?.length)return reject();
  const all=h.tiles??[],ts=all.slice(0,13);
  if(![13,14].includes(all.length))return reject();
  const rank=t=>{const m=/^([WBTZ])([0-9])$/.exec(t.tile??'');return m? 'WBTZ'.indexOf(m[1])*10+(Number(m[2])||5):NaN;};
  if(ts.some((t,i)=>!Number.isFinite(rank(t))||(i&&rank(t)<rank(ts[i-1]))))return reject();
  const gaps=ts.slice(1).map((t,i)=>t.center?.[0]-ts[i].center?.[0]);
  const pitch=[...gaps].sort((a,b)=>a-b)[6];
  if(!Number.isFinite(pitch)||pitch<=0||gaps.some(g=>!Number.isFinite(g)||Math.abs(g-pitch)>pitch*.2))return reject();
  if(all.length===14&&!(all[13].center?.[0]-ts[12].center[0]>pitch*1.2))return reject();
  const signature=JSON.stringify([key,ts.map(t=>t.tile)]),at=frame.capturedAt;
  const old=this.openingHandCandidate;
  if(!Number.isFinite(at))return reject();
  const centers=ts.map(t=>t.center);
  if(old?.signature!==signature||centers.some((c,i)=>c.some((v,j)=>Math.abs(v-old.centers[i][j])>2))){this.openingHandCandidate={signature,at,centers};return;}
  if(at-old.at<100)return;
  this.printedOpeningHand=key;
  this.line(`手牌：${tiles(ts)}`);
 }
 takeover(frame){
  if(this.takeoverFrame===frame.id&&frame.id!=null)return;
  this.takeoverFrame=frame.id;
  this.line('中盘接管：牌河按出牌顺序，副露按画面排列顺序');
  const seats=frame.round?.seat_identity?.seats??{};
  for(const seat of [0,1,2,3]){
   const position=Object.keys(seats).find(p=>seats[p]===seat);
   if(!position)continue;
   const who=`${honors[seat+1]}家${position==='self'?'（自己）':''}`;
   const river=frame.rivers?.[position];
   const riverText=river?.tiles?.map(t=>tileName(t)+(t.sideways?'（立直）':'')).join(' → ');
   this.line(`${who} 牌河：${riverText||(river?.complete?'无':'未识别')}${river?.complete?'':'（识别未完整）'}`);
   const melds=position==='self'?frame.own_melds:frame.opponent_melds?.[position];
   const meldText=melds?.groups?.map(g=>`${actions[g.kind]??g.kind} [${tiles(g.tiles)}]`).join('；');
   this.line(`${who} 副露：${meldText||(melds?.complete?'无':'未识别')}${melds?.complete?'':'（识别未完整）'}`);
  }
 }
 line(text){if(text===this.lastLine)return;this.lastLine=text;const code=logColors[logCategory(text)];const line=`[${new Date().toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}] ${text}`;this.write(this.color&&code?`\x1b[${code}m${line}\x1b[0m\n`:line+'\n');}
 observe(frame,history={}, {deferDraw=false}={}){
  reportMatchResult(frame,text=>this.line(text));
  reportSavedScreenshot(frame.result_page?.screenshot,text=>this.line(text));
  for(const path of frame.result_page?.additional_screenshots??[])reportSavedScreenshot(path,text=>this.line(text));
  this.scoreFrame=frame;
  this.updateDiscardModes(frame);
  // inspect() can emit the first draw before the runner accepts an opening.
  // Initial attachment may announce once. Later frame-level OCR changes
  // cannot announce a new round before the runner accepts its opening.
  this.startRound(frame,{confirmed:false});
  const seat=frame.round?.seat_identity;
  if(seat?.verified)this.selfSeat=seat.seats.self;
  // State is used only for deduplication; never print the full table/hand.
  const r=frame.round;
  if(!frame.hand?.complete||!r)return;
  const signature=JSON.stringify([r.wind,r.hand_number?.value,r.counters,r.remaining?.value,frame.hand.tiles.map(t=>t.tile)]);
  if(signature!==this.signature){this.signature=signature;this.messages.clear();}
  // A separated, fully decoded drawn tile is observable before history repair
  // and before the bot request. Do not mistake a post-call discard hand for a draw.
  const ts=frame.hand.tiles,n=ts.length;
  if(!deferDraw&&frame.hand.phase==='discard'&&n>=2&&!frame.selection?.verified&&!frame.call_choices?.verified){
   const gap=ts[n-1].center?.[0]-ts[n-2].center?.[0];
   const pitches=ts.slice(1,-1).map((t,i)=>t.center?.[0]-ts[i].center?.[0]).filter(x=>x>0).sort((a,b)=>a-b);
   // Four melds leave only one concealed tile, so there is no neighbouring
   // concealed pair to measure. Use the independently detected face width,
   // in the same restored screen coordinates as the tile centers.
   const widths=n===2?(frame.hand.face_boxes??[]).filter(([x,y,w,h])=>w>0&&ts.some(t=>t.center?.[0]>=x&&t.center?.[0]<=x+w&&t.center?.[1]>=y&&t.center?.[1]<=y+h)).map(b=>b[2]).sort((a,b)=>a-b):[];
   const pitch=pitches.length?pitches[Math.floor(pitches.length/2)]:widths.length===2?widths[1]:null;
   if(pitch!==null&&gap>1.2*pitch)this.publicEvent({state:`2 ${ts[n-1].tile}`});
  }
 }

 callWaitConfirmed(event){
  if(event.discard.seat===this.selfSeat){
   this.line(eventName({state:`3 ${event.discard.seat} PLAY ${event.discard.tile}`}));
   this.line(callWaitNotice(event));
   return;
  }
  this.callWaitNotices??=new Map();
  this.callWaitNotices.set(`${event.discard.seat}:${event.discard.river_index}`,event);
 }
 discardLine(event,index){
  this.line(eventName(event));
  const seat=event.state?.split(/\s+/)[1],key=`${seat}:${index}`;
  const notice=this.callWaitNotices?.get(key);
  if(notice){this.line(callWaitNotice(notice));this.callWaitNotices.delete(key);}
 }
 updateDiscardModes(frame,force=false){
  const r=frame?.round,key=JSON.stringify([r?.wind,r?.hand_number?.value,r?.counters?.honba,r?.seat_identity?.seats]);
  if(this.modeRound!==key){
   for(const p of this.pendingDiscardModes??[])this.discardLine(p.event,p.index);
   this.modeRound=key;this.pendingDiscardModes=[];
  }
  this.pendingDiscardModes??=[];
  let blocked=false;
  this.pendingDiscardModes=this.pendingDiscardModes.filter(p=>{
   if(blocked)return true;
   if(p.position===this.callWaitPending?.position&&this.callWaitPending?.slot===p.index){blocked=true;return true;}
   const tile=frame.rivers?.[p.position]?.tiles?.[p.index];
   if(tile?.tile===p.tile&&tile.discardMode&&!tile.discardEvidence?.inferred){
    this.discardLine({...p.event,discardMode:tile.discardMode,discardModeInferred:false},p.index);return false;
   }
   if(force||frame.capturedAt-p.at>=1500){this.discardLine(p.event,p.index);return false;}
   blocked=true;return true;
  });
 }
 trackDiscardMode(event){
  const [type,seat,kind,tile]=(event.state??'').split(/\s+/);
  if(type!=='3'||!['PLAY','LIZHI'].includes(kind))return;
  const f=this.scoreFrame,position=Object.keys(f?.round?.seat_identity?.seats??{}).find(p=>f.round.seat_identity.seats[p]===Number(seat));
  const ts=f?.rivers?.[position]?.tiles??[],index=ts.findLastIndex(t=>t.tile===tile);
  if(index<0)return;
  const waiting=(position===this.callWaitPending?.position&&this.callWaitPending?.slot===index)||this.callWaitNotices?.has(`${seat}:${index}`);
  if(position==='self'&&!waiting)return;
  if(!waiting&&event.discardMode&&!event.discardModeInferred&&!this.pendingDiscardModes?.length)return;
  this.pendingDiscardModes??=[];
  if(!Number.isFinite(f.capturedAt))return false;
  if(!this.pendingDiscardModes.some(p=>p.position===position&&p.index===index))this.pendingDiscardModes.push({position,index,tile,at:f.capturedAt,event:{...event}});
  return true;
 }

 unique(channel,text){if(this.messages.get(channel)===text)return;this.messages.set(channel,text);this.line(text);}
 decision(d,history={},request,frame=this.scoreFrame){
  const context=d.output.response==='PASS'?passContext(request):'';
  const action=actionName(d.output.response)+(context?'；'+context:''),discard=/^(PLAY|LIZHI|CHI|PENG)\s/.test(d.output.response);
  this.printedDecisions??=new WeakSet();
  if(this.printedDecisions.has(d))return;
  const suppress=!discard&&!context&&this.messages.get('decisionAction')===action;
  this.printedDecisions.add(d);this.messages.set('decisionAction',action);
  const roundKey=JSON.stringify([history.wind,history.handIndex,history.honba,history.seat]);
  // Start at the engine's zero reference; missing diagnostics must not erase
  // the last comparable decision within this hand.
  if(this.offRound!==roundKey){this.offRound=roundKey;this.previousOff=0;}
  const off=d.metrics?.off;
  const offDelta=Number.isFinite(off)&&Number.isFinite(this.previousOff)?off-this.previousOff:null;
  if(Number.isFinite(off))this.previousOff=off;
  if(suppress)return;
  const text=metricsText({...d.metrics,offDelta});
  this.lastLine=null;this.line(`决策：${action}${text?'；'+text:''}`);
  const waits=discardWaits(frame,history,d.output.response,request)?.filter(w=>w.remaining>0);
  if(waits?.length)this.line(waitsText(waits));
 }
 settlement(result,context,key){
  if(!result?.scores||!result?.seats)return;
  key=JSON.stringify([key,result.scores]);
  if(this.settlementKey===key)return;this.settlementKey=key;
  const parts=Object.entries(positions).map(([p,name])=>{const seat=result.seats[p],score=result.scores[seat],before=context?.scores?.[seat];const delta=Number.isInteger(before)&&!context?.estimated?score-before:null;return `${name} ${score}${delta===null?'':`（${delta>=0?'+':''}${delta}）`}`;});
  this.lastLine=null;this.line(`本局结算：${parts.join(' / ')}`);
 }
 publicEvent(e){
  const [type,seat,kind]=(e?.state??'').split(/\s+/);
  if(type==='2'){
   this.updateDiscardModes(this.scoreFrame,true);
   const f=this.scoreFrame,r=f?.round;
   const roundKey=JSON.stringify([r?.wind,r?.hand_number?.value,r?.counters?.honba]);
   if(this.drawRound!==roundKey){this.drawRound=roundKey;this.printedDraws=new Set();}
   const key=JSON.stringify([f?.rivers?.self?.tiles?.length,f?.own_melds?.groups?.filter(g=>['GANG','ANGANG','BUGANG'].includes(g.kind)).length,seat]);
   if(this.printedDraws.has(key))return;
   this.printedDraws.add(key);
   this.lastLine=null;this.line(eventName(scoredEvents([e],f)[0]));return;
  }
  if(type==='3'&&(kind==='DRAW'||Number(seat)===this.selfSeat))return;
  const scored=scoredEvents([e],this.scoreFrame)[0],name=eventName(scored);if(name){const key=e.state;if(this.messages.get('publicEventState')===key)return;this.messages.set('publicEventState',key);if(!this.trackDiscardMode(scored))this.unique('publicEvent',name);}
 }

 event(e){

  if(e.kind==='visible_public_events'){
   for(const request of scoredEvents(e.requests,this.scoreFrame)){
    const words=request.state?.split(' ')??[];
    if(words[0]==='DORA'||['GANG','ANGANG','BUGANG'].includes(words[2])){this.kongDoraLine(request);continue;}
    const name=eventName(request);if(name&&!this.trackDiscardMode(request)){this.lastLine=null;this.line(name);}
   }
  }
  else if(e.kind==='kong_confirmation'){
   const seat=this.selfSeat??this.scoreFrame?.round?.seat_identity?.seats?.self;
   if(Number.isInteger(seat))this.kongDoraLine(scoredEvents([{state:`3 ${seat} ${e.action}`}],this.scoreFrame)[0]);
  }
  else if(['input','staged_input'].includes(e.kind))this.line(`操作已发送；识别 ${ms(e.recognitionMs)} / 决策 ${ms(e.decisionMs)} / 操作 ${ms(e.operationMs)} / 总计 ${ms(e.totalMs)}`);
  else if(['confirmation','win_confirmation'].includes(e.kind))return;
  else if(e.kind==='auto_win_enable_sent')this.line('自动和牌：开启操作已发送');
  else if(e.kind==='auto_win_confirmed')this.line('自动和牌：已确认开启');
  else if(e.kind==='discard_prompt_dismissed')this.line('操作提示仍在：已点击过，等待提示关闭');
  else if(e.kind==='verified_unchanged_discard_retry')this.line(`新画面仍显示原手牌，已重试出牌：${actionName(e.action)}`);
  // Transient recognition transitions belong in events.jsonl, not gameplay output.
  else if(e.kind==='evidence_wait'||e.kind==='evidence_recovered')return;
  else if(e.kind==='recoverable_runtime_wait')this.unique('runtimeWait',e.reason.startsWith('Frozen game image')?'游戏画面连续60秒无变化，已暂停识别和点击，每秒检查画面恢复':`正在自动恢复采集和窗口焦点：${e.reason}`);
  else if(e.kind==='default_action_replacement')this.line(`请求动作已被替代：${actionName(e.requested)} → ${actionName(e.actual)}；已按实际动作接续`);
  else if(e.kind==='unexecuted_call_closed'){
   const [kind,tile]=e.action.split(' ');
   this.line(`鸣牌未执行：${actions[kind]}${tileName(tile)}`);
  }
  else if(e.kind==='stale_action_recovery')this.line(`旧操作确认已失效，接管当前回合：${e.reason}`);
  else if(['estimated_history','transaction_snapshot_recovery','initial_snapshot_recovery'].includes(e.kind)){
   this.line('已重建估计局面；原因：'+(e.reason??'从当前画面建立接续历史'));
  }
  else if(e.kind==='local_history_repair'&&e.reordered)this.line('已修复局面历史顺序；原因：'+e.reason);
  else if(e.kind==='unresolved')this.line(`尚未确认：${e.reason??e.status??'需要核对局面'}`);
 }
 kongDoraLine(event){
  const r=this.scoreFrame?.round,key=JSON.stringify([r?.wind,r?.hand_number?.value,r?.counters?.honba,r?.seat_identity?.seats]);
  if(this.kongDoraRound!==key){this.kongDoraRound=key;this.displayKongs=[];this.displayDora=[];}
  if(event.state.startsWith('DORA '))this.displayDora.push(event);else this.displayKongs.push(event);
  while(this.displayKongs.length&&this.displayDora.length){
   const kong=this.displayKongs.shift(),dora=this.displayDora.shift();
   this.lastLine=null;this.line(`${eventName(kong)}；${eventName(dora)}`);
  }
 }
}
