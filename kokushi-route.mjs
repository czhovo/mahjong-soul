import {GAME} from './game-rules.mjs';
import {roundIdentity} from './round-boundary.mjs';
import {nineTerminalsOpening} from './nine-terminals.mjs';
import {toolbarPoint} from './toolbar-point.mjs';

const orphans='W1 W9 B1 B9 T1 T9 Z1 Z2 Z3 Z4 Z5 Z6 Z7'.split(' ');
const counts=hand=>orphans.map(t=>hand.filter(x=>x===t).length);
const progress=c=>c.filter(n=>n>0).length+Number(c.some(n=>n>=2));

export function kokushiDiscards(hand){
 const c=counts(hand),best=progress(c);
 return [...new Set(hand)].filter(t=>{
  const i=orphans.indexOf(t);
  if(i<0)return true;
  if(c[i]===1)return false;
  const next=c.slice();next[i]--;
  return progress(next)===best;
 });
}

function impossible(frame,hand){
 const c=counts(hand),outside=new Map();
 const add=t=>outside.set(t,(outside.get(t)??0)+1);
 for(const p of GAME.positions){
  const r=frame.rivers?.[p];
  if(r?.complete)for(const t of r.tiles)if(t.color?.verified&&!t.tracking)add(t.tile);
  const m=p==='self'?frame.own_melds:frame.opponent_melds?.[p];
  if(m?.complete)for(const g of m.groups)for(const tile of g.tiles)add(tile.tile??tile);
  const north=frame.kita?.[p]?.count;
  if(Number.isInteger(north)&&north>=0&&north<=4)for(let n=0;n<north;n++)add('Z4');
 }
 if(frame.dora?.complete)for(const t of frame.dora.tiles)add(t.tile??t);
 // Do not count a currently offered winning tile as an inaccessible fourth copy.
 if(frame.controls?.RONG||frame.controls?.TSUMO||frame.controls?.HU)return false;
 if(orphans.some((t,i)=>!c[i]&&(outside.get(t)??0)>=4))return true;
 if(!c.some(n=>n>=2)&&orphans.every(t=>(outside.get(t)??0)>=3))return true;
 const wall=frame.round?.remaining;
 if(Number.isInteger(wall?.value)&&!wall.estimated){
  const needed=14-progress(c);
  if(needed>0&&(hand.length===14?needed>wall.value:(needed>1&&needed>wall.value)))return true;
 }
 return false;
}

export class KokushiRoute {
 active=false;
 openingTrial='unused';
 observe(frame,session){
  const id=roundIdentity(frame);
  if(id){
   const key=JSON.stringify(id);
   if(this.key&&this.key!==key){
    this.active=false;this.finished=false;this.toggleAt=null;this.openingTrial='unused';
   }
   this.key=key;
  }
  if(this.finished||!frame.hand?.complete||frame.hand.rejected?.length)return;
  if(frame.own_melds?.complete&&frame.own_melds.groups.length>0){
   this.active=false;this.finished=true;return;
  }
  const hand=frame.hand.tiles.map(t=>t.tile);
  if(![13,14].includes(hand.length))return;
  const kinds=orphans.filter(t=>hand.includes(t)).length;
  if(kinds>=10){
   this.active=true;this.openingTrial='closed';
  }else if(this.openingTrial==='unused'&&kinds===9){
   const opening=frame.controls?.KYUSHU||nineTerminalsOpening(frame)===true||
    (hand.length===13&&GAME.positions.every(p=>{
     const meld=p==='self'?frame.own_melds:frame.opponent_melds?.[p];
     return frame.rivers?.[p]?.complete&&frame.rivers[p].tiles.length===0&&meld?.complete&&!meld.groups.length;
    }));
   if(opening){this.active=true;this.openingTrial='pending';}
  }
  if(this.openingTrial==='pending'&&hand.length===14&&
     (frame.round?.turn?.position==='self'||frame.hand.phase==='discard'||frame.controls?.KITA)){
   const sameHand=id&&session?.discardObservation&&
    this.key===JSON.stringify(roundIdentity(session.discardObservation));
   this.checkThirdDraw(frame,sameHand?session.requests:[],session?.seat);
  }
  if(this.active&&impossible(frame,hand)){
   this.active=false;this.finished=true;
  }
 }
 checkThirdDraw(frame,history,seat,verifiedHand){
  if(this.openingTrial!=='pending')return;
  if(verifiedHand&&orphans.filter(t=>verifiedHand.includes(t)).length>=10){
   this.openingTrial='closed';return;
  }
  // Each completed discard starts the next regular draw. Replacement draws
  // and retries add no discard; a called-away discard remains in the ledger.
  const river=frame?.rivers?.self;
  let confirmed=0;
  for(const r of history??[]){
   const w=(r?.state??'').trim().split(/\s+/);
   if(w[0]==='0'){confirmed=0;continue;}
   if(w[0]==='3'&&Number(w[1])===seat&&(w[2]==='PLAY'||w[2]==='LIZHI'))confirmed++;
  }
  if(confirmed>=3||(river?.complete&&river.tiles.length>=3)){
   this.active=false;this.openingTrial='closed';
  }
 }
 async disableAutoNorth(frame,adapter){
  if(!GAME.sanma||!this.active||!frame.auto_kita?.verified||!frame.auto_kita.enabled)return false;
  const fresh=Number.isFinite(frame.captureStartedMono)?frame.captureStartedMono>this.toggleAt:frame.id!==this.toggleFrame;
  if(this.toggleAt==null||(fresh&&performance.now()-this.toggleAt>1200)){
   this.toggleAt=performance.now();this.toggleFrame=frame.id;
   await adapter.sendClick(frame,toolbarPoint(frame,'kita3'),'toggle');
   delete adapter.autoKitaOutput;
  }
  return true;
 }
 filter(actions,hand,event){
  if(!this.active||event.observedCallBeforeDiscard)return actions;
  const state=(event.state??'').trim();
  const own=state.startsWith('2 ');
  if(!own)return ['PASS'];
  const kinds=actions.map(a=>a.trim().split(/\s+/)[0]);
  if(kinds.length>0&&kinds.every(k=>k==='PASS'))return ['PASS'];
  const rawDiscards=kokushiDiscards(hand);
  const discards=GAME.sanma?rawDiscards.filter(t=>t!=='Z4'):rawDiscards;
  const allowed=(action,tiles)=>{
   const parts=action.trim().split(/\s+/);
   return parts.length===1?tiles:tiles.filter(t=>parts.slice(1).includes(t));
  };
  const filtered=actions.flatMap(action=>{
   const kind=action.trim().split(/\s+/)[0];
   if(kind==='KITA'&&GAME.sanma&&hand.filter(t=>t==='Z4').length>1)return [action];
   if(kind!=='PLAY')return [];
   const tiles=allowed(action,discards);
   return tiles.length?[[kind,...tiles].join(' ')]:[];
  });
  if(!filtered.length&&GAME.sanma&&rawDiscards.includes('Z4')&&kinds.includes('PLAY'))return ['PLAY Z4'];
  if(!filtered.length&&!kinds.includes('PLAY')&&kinds.includes('PASS'))return ['PASS'];
  return filtered;
 }
}
