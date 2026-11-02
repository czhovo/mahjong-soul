import {publicEvents} from './public-events.mjs';
import {canonicalMelds,callEvent} from './meld-events.mjs';
import {reactionSpan} from './reaction-span.mjs';
import {chainedCallSpan} from './chained-call-span.mjs';
import {roundIdentity} from './round-boundary.mjs';
import {depositsConsistent} from './riichi-deposits.mjs';
import {riverTransition} from './river-events.mjs';
import {estimateWall,fillWall} from './wall-estimate.mjs';

function snapshotTail(before,after,session){
 const boundary=session.snapshotBoundary;
 if(!before.id||boundary?.id!==before.id||!boundary.river||session.pending)return null;
 const identity=roundIdentity(before),eq=(x,y)=>JSON.stringify(x)===JSON.stringify(y);
 if(!identity||!eq(identity,roundIdentity(after)))return null;
 const h=f=>f.hand.tiles.map(t=>t.tile).sort();
 if(!before.hand.complete||!after.hand.complete||!eq(h(before),h(after))||
    !eq(canonicalMelds(before,'self',before.own_melds),canonicalMelds(after,'self',after.own_melds)))return null;
 const delta=riverTransition(before,after);
 if(!delta.verified&&delta.reason==='multiple_discards_order_unknown'&&!boundary.actorCertain&&delta.additions.every(x=>x.position!=='self')){
  const ps=new Set(delta.additions.map(x=>x.position));
  if(ps.size===delta.additions.length&&Object.keys(identity.seats).every(p=>{
   const old=before.rivers[p].tiles,fresh=after.rivers[p].tiles;
   return old.every((t,i)=>t.sideways===fresh[i].sideways)&&
    eq(boundary.river[p],old.map(t=>[t.tile,t.sideways]))&&fresh.slice(old.length).every(t=>t.color?.verified&&!t.tracking&&typeof t.sideways==='boolean');
  })){
   const start=[...ps].filter(p=>![...ps].some(q=>identity.seats[q]===(identity.seats[p]+3)%4));
   if(start.length===1)return {observedActor:identity.seats[start[0]]};
  }
 }
 if(!delta.verified||delta.kind!=='discard')return null;
 const {position,index,tile}=delta.additions[0],face=after.rivers[position].tiles[index];
 if(!face.color?.verified||face.tracking||typeof face.sideways!=='boolean'||!depositsConsistent(before,after,+face.sideways))return null;
 const pairs=r=>r.tiles.map(t=>[t.tile,t.sideways]);
 for(const p of Object.keys(identity.seats)){
  const old=pairs(before.rivers[p]),fresh=pairs(after.rivers[p]);
  if(!eq(old,fresh.slice(0,old.length)))return null;
  if(!eq(boundary.river[p],old)&&!(p===position&&eq(boundary.river[p],fresh)))return null;
 }
 const alignWall=()=>{if(!Number.isInteger(after.round.remaining?.value)){
  const n=estimateWall(after)??before.round.remaining?.value;if(Number.isInteger(n))fillWall(after,n,'snapshot-river-alignment');
 }};
 if(eq(boundary.river[position],pairs(after.rivers[position]))){alignWall();return {verified:true,requests:[],alignSnapshotRiver:true};}
 const seat=identity.seats[position];
 if(position!=='self')return boundary.actorCertain?null:{observedActor:seat};
 if(after.controls?.PASS||h(after).length!==13-3*after.own_melds.groups.length)return null;
 alignWall();
 // Both checkpoints already show the post-discard concealed hand. Supply the
 // now visible river tile before replaying PLAY so it is removed exactly once.
 return {verified:true,requests:[{handTiles:'1 '+[...after.hand.tiles.map(t=>t.tile),tile].join(' '),validact:null},
  {state:`3 ${seat} ${face.sideways?'LIZHI':'PLAY'} ${tile}`,validact:null}]};
}
export function publicContinuation(before,after,session){
 // PASS does not alter the table. Its triggering discard/call is already
 // visible in `before`, but is not committed to the session until confirmation.
 // Use that pending input's ledger and prefix together, without committing it.
 if(session.pending?.output?.response==='PASS'&&session.pending.ledger&&session.pending.input?.requests){
  session={...session,ledger:session.pending.ledger,requests:session.pending.input.requests};
 }
 const seats=after.round.seat_identity.seats;
 const changes=[];
 for(const p of ['right','opposite','left']){
  const oldMelds=canonicalMelds(before,p,before.opponent_melds[p]),newMelds=canonicalMelds(after,p,after.opponent_melds[p]);
  if(JSON.stringify(oldMelds)!==JSON.stringify(newMelds))changes.push({actor:p,oldMelds,newMelds});
 }
 if(changes.length===1){
  const change=changes[0],view=structuredClone(after);
  const added=change.newMelds.filter(m=>!change.oldMelds.some(n=>JSON.stringify(n)===JSON.stringify(m)));
  // The source discard can leave the table between captures. A newly
  // exposed meld identifies both the source and tile; the caller's new
  // river face identifies the follow-up discard independently.
  if(!session.pending&&before.id&&session.snapshotBoundary?.id===before.id&&added.length===1&&
     change.newMelds.length===change.oldMelds.length+1&&['CHI','PENG'].includes(added[0].kind)&&
     roundIdentity(before)&&JSON.stringify(roundIdentity(before))===JSON.stringify(roundIdentity(after))&&
     before.hand.complete&&after.hand.complete&&before.hand.tiles.length===13-3*before.own_melds.groups.length&&
     JSON.stringify(canonicalMelds(before,'self',before.own_melds))===JSON.stringify(canonicalMelds(after,'self',after.own_melds))&&
     before.hand.tiles.map(t=>t.tile).sort().join(' ')===after.hand.tiles.map(t=>t.tile).sort().join(' ')&&
     before.round.counters.riichi_sticks===after.round.counters.riichi_sticks){
   const m=added[0],tiles=m.tiles.slice(),called=tiles.splice(m.calledIndex,1)[0],actor=seats[change.actor];
   const river=riverTransition(before,after),last=after.rivers[change.actor].tiles.at(-1);
   const wall=before.round.remaining?.value,now=after.round.remaining?.value;
   const prefixOK=Object.keys(seats).every(p=>before.rivers[p].tiles.every((t,i)=>t.sideways===after.rivers[p].tiles[i]?.sideways)&&
    JSON.stringify(session.snapshotBoundary.river?.[p])===JSON.stringify(before.rivers[p].tiles.map(t=>[t.tile,t.sideways])));
   if(prefixOK&&river.verified&&river.kind==='discard'&&river.additions[0].position===change.actor&&
      last?.color?.verified&&!last.tracking&&last.sideways===false&&
      !after.opponent_melds[change.actor].groups.some(g=>g.estimated)&&
      Number.isInteger(wall)&&Number.isInteger(now)&&[0,1].includes(wall-now)&&
      (m.kind!=='CHI'||(actor+3)%4===m.from)){
    const events=[];
    if(m.from===seats.self)events.push({handTiles:'1 '+[...before.hand.tiles.map(t=>t.tile),called].join(' '),validact:null});
    else if(wall-now===1)events.push({state:`3 ${m.from} DRAW`,validact:null});
    events.push({state:`3 ${m.from} PLAY ${called}`,validact:null},{state:`3 ${actor} ${m.kind} ${called} ${tiles.join(' ')} ${last.tile}`,validact:null});
    return {verified:true,requests:events};
   }
  }
  if(added.length===1&&change.oldMelds.every(m=>change.newMelds.some(n=>JSON.stringify(n)===JSON.stringify(m)))&&['CHI','PENG'].includes(added[0].kind)&&
     before.round.remaining.value===after.round.remaining.value&&
     JSON.stringify(before.hand.tiles.map(t=>t.tile).sort())===JSON.stringify(after.hand.tiles.map(t=>t.tile).sort())){
   const m=added[0],called=m.tiles[m.calledIndex];
   const pending=['self','right','opposite','left'].every(p=>{
    const old=before.rivers[p],next=after.rivers[p];if(!old?.complete||!next?.complete)return false;
    const tiles=old.tiles.map(t=>t.tile);
    if(seats[p]===m.from&&tiles.pop()!==called)return false;
    return JSON.stringify(tiles)===JSON.stringify(next.tiles.map(t=>t.tile));
   });
   if(pending)return {verified:true,requests:[],pendingCall:true};
  }
  let draw=null;
  if(after.hand.tiles.length===before.hand.tiles.length+1&&(seats[change.actor]+1)%4===seats.self){
   const tiles=after.hand.tiles;
   if(!tiles.at(-1)?.center||!tiles.at(-2)?.center||tiles.at(-1).center[0]-tiles.at(-2).center[0]<80)throw Error('Unproved draw after public call');
   draw=view.hand.tiles.pop().tile;view.round.remaining.value++;
  }
  const span=callEvent(before,view,{...change,lastDiscard:{seat:session.ledger.lastPlayer,tile:session.ledger.lastDiscard}});
  if(!span.verified)return publicCallChain(before,after,session);
  if(draw)span.requests.push({state:`2 ${draw}`,validact:'PLAY'});
  return span;
 }
 if(changes.length)return publicCallChain(before,after,session);
 const boundary=snapshotTail(before,after,session);
 if(boundary?.verified)return boundary;
 const last=session.requests?.at(-1)?.state??'',match=/^3 ([0-3]) DRAW$/.exec(last);
 // An observed draw is already in the protocol ledger. The next discard
 // must not emit it again merely because the wall digit/turn lamp lagged.
 if(match)return reactionSpan(before,after,session.ledger.lastPlayer,{committedDraw:Number(match[1])});
 const span=publicEvents(before,after,seats);
 if(span.verified){
  const draw=/^3 ([0-3]) DRAW$/.exec(span.requests[0]?.state??'');
  // A turn lamp may briefly point at the next player. Do not commit a draw
  // that skips the player following the last confirmed discard/call.
  if(!draw||session.ledger.lastPlayer==null||Number(draw[1])===(session.ledger.lastPlayer+1)%4||Number(draw[1])===boundary?.observedActor)return span;
 }
 if(boundary?.observedActor!=null){
  const seat=boundary.observedActor,delta=before.round.remaining.value-after.round.remaining.value;
  return reactionSpan(before,after,(seat+3)%4,{committedDraw:delta===0&&seats[before.round.turn?.position]===seat?seat:null});
 }
 return reactionSpan(before,after,session.ledger.lastPlayer);
}
function publicCallChain(before,after,session){
 const tile=session.ledger.lastDiscard,seat=session.ledger.lastPlayer;
 const decision={output:{response:`PLAY ${tile}`},visibleHand:before.hand.tiles.map(t=>t.tile)};
 const committedDraw=/^3 ([0-3]) DRAW$/.exec(session.requests?.at(-1)?.state??'');
 if(committedDraw)return chainedCallSpan(decision,before,after,{publicStart:{seat:Number(committedDraw[1]),tile,phase:'draw'}});
 try{return chainedCallSpan(decision,before,after,{publicStart:{seat,tile}});}
 catch(error){
  const drawn=before.round?.seat_identity?.seats?.[before.round?.turn?.position];
  if(!/Chained call ordering absent/.test(error.message)||before.controls?.PASS||drawn==null||drawn!==(seat+1)%4)throw error;
  // A snapshot taken during an opponent's turn may already include its draw
  // in the visible wall count. Try that phase without counting it twice.
  const span=chainedCallSpan(decision,before,after,{publicStart:{seat,tile,committedDraw:drawn}});
  return {...span,estimated:true,assumptions:[...(span.assumptions??[]),'衔接起始玩家的摸牌已计入起始余牌数，不重复补摸牌事件']};
 }
}
