import {GAME} from './game-rules.mjs';
import {roundIdentity} from './round-boundary.mjs';
import {confirmedNorthStock} from './kita-evidence.mjs';
import {hasSeparatedDraw} from './draw-separation.mjs';
import {canonicalMelds} from './meld-events.mjs';
import {applyPublicEvent,assertVisibleHand} from './hand-ledger.mjs';

// Recover visible extractions and a subsequent discard; report draw order
// only when the observed hand and any intermediate frames determine it.
export function observedOwnKitaDiscard(pending,after){
 const before=pending?.before,d=pending?.decision;
 if(!GAME.sanma||!(d?.output?.response?.startsWith('PLAY ')||d?.output?.response==='KITA Z4')||!d.ledger||
    !before?.hand?.complete||!after.hand?.complete||after.hand.rejected?.length||
    !roundIdentity(before)||JSON.stringify(roundIdentity(before))!==JSON.stringify(roundIdentity(after)))return null;
 const oldCount=before.kita?.self?.count,stock=after.kita?.self;
 const n=stock?.count-oldCount;
 if(!Number.isInteger(oldCount)||!Number.isInteger(n)||n<1||n>4||!confirmedNorthStock(stock))return null;
 for(const p of GAME.positions){
  const a=p==='self'?before.own_melds:before.opponent_melds?.[p];
  const b=p==='self'?after.own_melds:after.opponent_melds?.[p];
  if(!a?.complete||!b?.complete||JSON.stringify(canonicalMelds(before,p,a))!==JSON.stringify(canonicalMelds(after,p,b)))return null;
 }
 const a=before.rivers?.self,b=after.rivers?.self;
 if(!a?.complete||!b?.complete||b.tiles.length!==a.tiles.length+1||
    a.tiles.some((t,i)=>t.tile!==b.tiles[i].tile||t.sideways!==b.tiles[i].sideways))return null;
 const discarded=b.tiles.at(-1);
 if(discarded.sideways!==false||!discarded.color?.verified||discarded.tracking)return null;
 const base=after.hand.tiles.slice(),waiting=13-3*after.own_melds.groups.length;
 if(base.length===waiting+1){
  if(!hasSeparatedDraw(base,{priorTiles:before.hand?.tiles}))return null;
  base.pop();
 }
 if(base.length!==waiting)return null;
 const beforeDiscard=[...base.map(t=>t.tile),discarded.tile];
 const difference=[...beforeDiscard,...Array(n).fill('Z4')];
 for(const tile of d.visibleHand){const i=difference.indexOf(tile);if(i<0)return null;difference.splice(i,1);}
 if(difference.length!==n||!d.visibleHand.includes('Z4'))return null;
 const seat=d.ledger.seat,extra=[],draws=[...difference],northEvent={state:`3 ${seat} KITA Z4`,validact:null};
 let north=d.visibleHand.filter(t=>t==='Z4').length;
 const known=pending.knownKitaDraws??[];
 if(known.length>n)return null;
 for(const t of known){const i=difference.indexOf(t);if(i<0)return null;difference.splice(i,1);}
 const ordered=new Set(difference).size<=1?[...known,...difference]:null;
 if(ordered){
  for(const t of ordered){if(--north<0)return null;extra.push(northEvent,{state:'2 '+t,validact:null});if(t==='Z4')north++;}
 }else{
  // Two different replacement tiles already joined the hand. Commit the
  // visible Norths and the verified hand, without inventing their draw order.
  for(let i=0;i<n;i++){
   if(--north<0)return null;
   extra.push(northEvent);
   if(i<known.length){extra.push({state:'2 '+known[i],validact:null});if(known[i]==='Z4')north++;}
   else if(!north&&i+1<n){const k=difference.indexOf('Z4');if(k<0)return null;difference.splice(k,1);extra.push({state:'2 Z4',validact:null});north++;}
  }
  extra.push({handTiles:'1 '+beforeDiscard.join(' '),source:'verified-post-kita-hand',validact:null});
 }
 const draw=ordered?.at(-1)??null;
 let ledger=d.ledger;
 try{for(const r of extra)ledger=applyPublicEvent(ledger,r);assertVisibleHand(applyPublicEvent(ledger,{state:`3 ${seat} PLAY ${discarded.tile}`}),base.map(t=>t.tile));}catch{return null;}
 const decision={...d,output:{...d.output,response:`PLAY ${discarded.tile}`},ledger,visibleHand:[...ledger.hand],
  input:{...d.input,requests:[...d.input.requests,...extra],responses:[...d.input.responses,...extra.map(()=> 'PASS')]}};
 // A baseline immediately after this own discard preserves opponent changes
 // for the usual incremental continuation; none of their later events are lost.
 const baseline=structuredClone(before);
 baseline.id=after.id+':confirmed-own-kita-discard';
 baseline.kita.self=structuredClone(stock);
 baseline.hand={...structuredClone(after.hand),tiles:structuredClone(base),face_count:waiting,expected_count:waiting,phase:'waiting'};
 baseline.rivers.self=structuredClone(b);baseline.controls={};
 if(Number.isInteger(before.round.remaining?.value))baseline.round.remaining={value:before.round.remaining.value-n};
 baseline.round.turn={position:GAME.positions.find(p=>baseline.round.seat_identity.seats[p]===(seat+1)%GAME.players)};
 return {decision,baseline,extra,draw,draws:ordered??draws,orderKnown:!!ordered,requested:d.output.response,actual:decision.output.response};
}
