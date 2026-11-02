import {assertVisibleHand} from './hand-ledger.mjs';
import {roundIdentity} from './round-boundary.mjs';
import {callCombinations} from './planned-call-choice.mjs';

const meldEvidence=frame=>Object.fromEntries(['self','right','opposite','left'].map(p=>{
 const m=p==='self'?frame.own_melds:frame.opponent_melds?.[p];
 return [p,m?.complete?JSON.stringify(m.groups.map(g=>JSON.stringify([g.kind,[...g.tiles].sort(),g.fromRelative,g.tiles[g.calledIndex]])).sort()):null];
}));
const changedMeldEvidence=(a,b)=>Object.keys(a).some(p=>a[p]!==null&&b[p]!==null&&a[p]!==b[p]);

// CHI fixes the source even during the dark part of the turn lamp. For PENG
// use the lit opponent; never select a player just because their tail matches.
export function promptDiscard(frame){
 const c=frame.controls,round=roundIdentity(frame);
 if(!round||!c?.PASS||(!c.CHI&&!c.PENG)||!frame.hand?.complete)return null;
 const lit=frame.round.turn?.position,position=c.CHI?'left':lit;
 if(!['left','opposite','right'].includes(position)||(lit&&lit!==position))return null;
 const r=frame.rivers?.[position],t=r?.tiles?.at(-1);
 if(!t?.color?.verified||t.tracking||typeof t.sideways!=='boolean')return null;
 // A rejected old identity does not obscure the last discard if every
 // occupied outline is accounted for by a decoded tile.
 if(!r.complete&&(!r.face_boxes?.length||r.face_count!==r.tiles.length||
    !r.face_boxes.every(([x,y,w,h])=>r.tiles.some(v=>v.center&&v.center[0]>=x-2&&v.center[0]<=x+w+2&&v.center[1]>=y-2&&v.center[1]<=y+h+2))))return null;
 const hand=frame.hand.tiles.map(v=>v.tile);
 if(['CHI','PENG'].some(k=>c[k]&&!callCombinations(hand,k,t.tile).length))return null;
 return {round,position,slot:r.tiles.length-1,tile:t.tile,sideways:t.sideways,melds:meldEvidence(frame),
  event:{state:`3 ${round.seats[position]} ${t.sideways?'LIZHI':'PLAY'} ${t.tile}`,validact:null}};
}

// Keep the last complete prefix for each river across unread animation frames.
// A complete shrink (called-away tile) replaces the prefix; never carry it
// across a round boundary or invent the identity of an unread new tile.
export class ReactionObservationCache {
 observe(frame){
  const round=roundIdentity(frame),key=JSON.stringify(round);
  if(!round)return null;
  if(this.key!==key){this.key=key;this.before=null;this.priorMelds={};}
  const evidence=newDiscardEvidence(this.before,frame);
  if(!this.before)this.before={round:structuredClone(frame.round),rivers:{}};
  const seats=['self','right','opposite','left'],groups=p=>p==='self'?frame.own_melds:frame.opponent_melds?.[p];
  const signature=g=>JSON.stringify([g.kind,g.tiles,g.calledIndex,g.fromRelative]);
  for(const p of seats.slice(1)){
   const old=this.before.rivers[p],r=frame.rivers?.[p];if(!r?.complete)continue;
   if(old&&r.tiles.length<old.tiles.length){
    const taken=old.tiles.length===r.tiles.length+1&&r.tiles.every((t,i)=>old.tiles[i].tile===t.tile)&&seats.some((owner,i)=>
     groups(owner)?.complete&&groups(owner).groups.some(g=>['CHI','PENG','GANG'].includes(g.kind)&&
      seats[(i+({left:3,opposite:2,right:1}[g.fromRelative]))%4]===p&&g.tiles?.[g.calledIndex]===old.tiles.at(-1).tile&&
      this.priorMelds[owner]&&!this.priorMelds[owner].includes(signature(g))));
    if(!taken)continue;
   }
   this.before.rivers[p]=structuredClone(r);
  }
  for(const owner of seats)if(groups(owner)?.complete)this.priorMelds[owner]=groups(owner).groups.map(signature);
  return evidence;
 }
}

export function newDiscardEvidence(recent,frame,{includeSelf=false}={}){
 const round=roundIdentity(frame);
 if(!round||!recent||JSON.stringify(roundIdentity(recent))!==JSON.stringify(round))return null;
 const additions=[];
 for(const p of (includeSelf?['self','right','opposite','left']:['right','opposite','left'])){
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
  const fresh=newDiscardEvidence(recent,frame);
  const evidence=(fresh&&(!frame.controls.CHI||fresh.position==='left')?fresh:null)??promptDiscard(frame)??reactionEvidence;
  if(evidence&&(!frame.controls.CHI||evidence.position==='left')&&JSON.stringify(evidence.round)===JSON.stringify(round)&&
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
  if(frame.controls.CHI&&p!=='left')return null;
  const previous=before.rivers?.[p],next=frame.rivers?.[p];
  if(!previous?.complete||!next?.complete||JSON.stringify(previous.tiles.map(t=>t.tile))!==JSON.stringify(next.tiles.map(t=>t.tile)))return null;
  try{assertVisibleHand(session.ledger,visible);}catch{return null;}
  return {requests:[event],reuseObserved:true};
 }
 return null;
}
