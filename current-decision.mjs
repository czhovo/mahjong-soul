import {assertVisibleHand} from './hand-ledger.mjs';
import {roundIdentity} from './round-boundary.mjs';

const meldEvidence=frame=>Object.fromEntries(['self','right','opposite','left'].map(p=>{
 const m=p==='self'?frame.own_melds:frame.opponent_melds?.[p];
 return [p,m?.complete?JSON.stringify(m.groups.map(g=>JSON.stringify([g.kind,[...g.tiles].sort(),g.fromRelative,g.tiles[g.calledIndex]])).sort()):null];
}));
const changedMeldEvidence=(a,b)=>Object.keys(a).some(p=>a[p]!==null&&b[p]!==null&&a[p]!==b[p]);

// Keep the last complete prefix for each river across unread animation frames.
// A complete shrink (called-away tile) replaces the prefix; never carry it
// across a round boundary or invent the identity of an unread new tile.
export class ReactionObservationCache {
 observe(frame){
  const round=roundIdentity(frame),key=JSON.stringify(round);
  if(!round)return null;
  if(this.key!==key){this.key=key;this.before=null;}
  const evidence=newDiscardEvidence(this.before,frame);
  if(!this.before)this.before={round:structuredClone(frame.round),rivers:{}};
  for(const p of ['right','opposite','left'])if(frame.rivers?.[p]?.complete)this.before.rivers[p]=structuredClone(frame.rivers[p]);
  return evidence;
 }
}

export function newDiscardEvidence(recent,frame){
 const round=roundIdentity(frame);
 if(!round||!recent||JSON.stringify(roundIdentity(recent))!==JSON.stringify(round))return null;
 const additions=[];
 for(const p of ['right','opposite','left']){
  const a=recent.rivers?.[p],b=frame.rivers?.[p];
  if(!a?.complete||!b||a.tiles.some((t,i)=>t.tile!==b.tiles[i]?.tile)||b.tiles.length<a.tiles.length)continue;
  for(const [i,t] of b.tiles.slice(a.tiles.length).entries())additions.push({p,t,slot:a.tiles.length+i});
 }
 if(additions.length!==1)return null;
 const {p,t,slot}=additions[0];
 if(!t.color?.verified||t.tracking||typeof t.sideways!=='boolean'||t.row*6+t.column!==slot)return null;
 return {round,position:p,slot,tile:t.tile,sideways:t.sideways,melds:meldEvidence(frame),event:{state:`3 ${round.seats[p]} ${t.sideways?'LIZHI':'PLAY'} ${t.tile}`,validact:null}};
}

// Decision availability is independent of complete historical river OCR.
// Preserve the protocol prefix; never restore a snapshot or invent missing
// public events. The concealed hand still has to match the committed ledger.
export function currentDecision(session,before,frame,recent,{consumed=[],publicMode=false,reactionEvidence=null}={}){
 if(session.pending||!session.ledger?.hand||!frame.hand?.complete||!frame.own_melds?.complete)return null;
 const round=roundIdentity(frame);
 if(!round||JSON.stringify(round)!==JSON.stringify(roundIdentity(before)))return null;
 const tiles=frame.hand.tiles,visible=tiles.map(t=>t.tile);
 if(tiles.length===14-3*frame.own_melds.groups.length){
  // The recognizer keeps the separate drawn tile last. Confirm the other
  // tiles exactly, so a changed hand can never be treated as a new draw.
  try{assertVisibleHand(session.ledger,visible.slice(0,-1));}catch{return null;}
  // Preserve readable new public tails even if an unrelated region or old
  // anchor was marked incomplete. Never fabricate an unread tile identity.
  const prefix=[];let compatible=true;
  const start=publicMode?session.ledger.lastPlayer:round.seats.self;
  if(!Number.isInteger(start))compatible=false;
  for(let n=1;compatible&&n<=3;n++){
   const seat=(start+n)%4;if(seat===round.seats.self)break;
   const p=Object.keys(round.seats).find(p=>round.seats[p]===seat);
   const a=before.rivers?.[p],b=frame.rivers?.[p];
   if(!a||!b||a.tiles.some((t,i)=>t.tile!==b.tiles[i]?.tile)||b.tiles.length<a.tiles.length){compatible=false;break;}
   for(const [i,t] of b.tiles.slice(a.tiles.length).entries()){
    if(!t.color?.verified||t.tracking||typeof t.sideways!=='boolean'){compatible=false;break;}
    if(i||session.requests?.at(-1)?.state!==`3 ${seat} DRAW`)prefix.push({state:`3 ${seat} DRAW`,validact:null,historyOrderCertain:false});
    prefix.push({state:`3 ${seat} ${t.sideways?'LIZHI':'PLAY'} ${t.tile}`,validact:null,historyOrderCertain:false});
   }
  }
  if(consumed.some((s,i)=>prefix[i]?.state!==s))compatible=false;
  return {requests:[...(compatible?prefix.slice(consumed.length):[]),{state:`2 ${visible.at(-1)}`,validact:'PLAY'}],estimated:true,
   assumptions:['历史观察未能完整衔接；保留已提交历史，以与账本完全一致的当前手牌和新摸牌立即决策，不重建']};
 }
 if(frame.controls?.PASS){
  try{assertVisibleHand(session.ledger,visible);}catch{return null;}
  const evidence=newDiscardEvidence(recent,frame)??reactionEvidence;
  if(evidence&&JSON.stringify(evidence.round)===JSON.stringify(round)&&
     !changedMeldEvidence(evidence.melds??{},meldEvidence(frame))){
   const river=frame.rivers?.[evidence.position],t=river?.tiles?.[evidence.slot];
   if(river?.tiles.length===evidence.slot+1&&t?.tile===evidence.tile&&t.sideways===evidence.sideways&&t.color?.verified&&!t.tracking){
    const reused=before.rivers?.[evidence.position]?.tiles.length===evidence.slot+1&&session.requests?.at(-1)?.state===evidence.event.state&&session.responses?.at(-1)==='PASS';
    return {requests:[evidence.event],reuseObserved:reused,estimated:true,
     assumptions:['保留已提交历史，使用已观察到的新增弃牌响应当前按钮；无关牌河不阻塞反应决策']};
   }
  }
  const event=session.requests?.at(-1);
  if(changedMeldEvidence(meldEvidence(before),meldEvidence(frame)))return null;
  if(!/^3 [0-3] (PLAY|LIZHI|CHI|PENG|BUGANG) /.test(event?.state??''))return null;
  const seat=Number(event.state.split(' ')[1]);
  const p=Object.keys(round.seats).find(p=>round.seats[p]===seat);
  const previous=before.rivers?.[p],next=frame.rivers?.[p];
  if(!previous?.complete||!next?.complete||JSON.stringify(previous.tiles.map(t=>t.tile))!==JSON.stringify(next.tiles.map(t=>t.tile)))return null;
  try{assertVisibleHand(session.ledger,visible);}catch{return null;}
  return {requests:[event],reuseObserved:true};
 }
 return null;
}
