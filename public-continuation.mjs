import {publicEvents} from './public-events.mjs';
import {canonicalMelds,callEvent} from './meld-events.mjs';
import {reactionSpan} from './reaction-span.mjs';
import {chainedCallSpan} from './chained-call-span.mjs';
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
 const last=session.requests?.at(-1)?.state??'',match=/^3 ([0-3]) DRAW$/.exec(last);
 // An observed draw is already in the protocol ledger. The next discard
 // must not emit it again merely because the wall digit/turn lamp lagged.
 if(match)return reactionSpan(before,after,session.ledger.lastPlayer,{committedDraw:Number(match[1])});
 const span=publicEvents(before,after,seats);
 if(span.verified){
  const draw=/^3 ([0-3]) DRAW$/.exec(span.requests[0]?.state??'');
  // A turn lamp may briefly point at the next player. Do not commit a draw
  // that skips the player following the last confirmed discard/call.
  if(!draw||session.ledger.lastPlayer==null||Number(draw[1])===(session.ledger.lastPlayer+1)%4)return span;
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
