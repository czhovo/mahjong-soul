import {canonicalMelds} from './meld-events.mjs';
// Validate visible game effects, independently of an input-driver receipt.
const sorted=a=>[...a].sort().join(' ');
// Local effect proof does not depend on an old river still being readable.
export function verifyLocalDiscard(decision,before,after,{currentDraw=false,ownRiichi=false}={}){
 const match=/^(PLAY|LIZHI) ([WBT][0-9]|Z[1-7])$/.exec(decision.output.response);
 const a=before.round,b=after.round;
 if(!match||!after.hand?.complete||after.hand.rejected?.length||!before.own_melds?.complete||!after.own_melds?.complete||
    !a?.seat_identity?.verified||!b?.seat_identity?.verified||a.wind!==b.wind||a.hand_number.value!==b.hand_number.value||a.counters.honba!==b.counters.honba||
    JSON.stringify(a.seat_identity.seats)!==JSON.stringify(b.seat_identity.seats))throw Error('Incomplete local discard state');
 const melds=f=>JSON.stringify(canonicalMelds(f,'self',f.own_melds));
 if(melds(before)!==melds(after))throw Error('Own meld changed during discard');
 const expected=[...decision.visibleHand],i=expected.indexOf(match[2]);
 if(i<0)throw Error('Discard absent');expected.splice(i,1);
 const visible=after.hand.tiles.map(t=>t.tile);let nextDraw=null;
 if(visible.length===expected.length+1){
  const tiles=after.hand.tiles;
  const pitches=tiles.slice(1,-1).map((t,i)=>t.center?.[0]-tiles[i].center?.[0]).filter(x=>Number.isFinite(x)&&x>0).sort((a,b)=>a-b);
  const pitch=pitches[Math.floor(pitches.length/2)];
  const wallAdvanced=Number.isInteger(a.remaining?.value)&&Number.isInteger(b.remaining?.value)&&b.remaining.value<a.remaining.value;
  const currentTurn=currentDraw&&wallAdvanced&&(b.turn?.position==null||b.turn.position==='self')&&visible.length===14-3*after.own_melds.groups.length;
  if(!currentTurn&&(tiles.length<2||!pitch||!tiles.at(-1).center||!tiles.at(-2).center||tiles.at(-1).center[0]-tiles.at(-2).center[0]<pitch*1.18))throw Error('Draw not separated');
  nextDraw=visible.pop();
  if(sorted(after.hand.tiles.map(t=>t.tile))===sorted(decision.visibleHand))throw Error('Unchanged original hand');
 }
 if(sorted(visible)!==sorted(expected))throw Error('Local discard hand mismatch');
 if(match[1]==='LIZHI'&&!ownRiichi&&!(after.rivers?.self?.tiles??[]).some(t=>t.tile===match[2]&&t.sideways===true))throw Error('Own riichi not visible');
 return {action:decision.output.response,gameConfirmed:true,nextDraw,source:'current-hand-and-own-melds',before:before.id,after:after.id};
}
// This is only evidence to keep observing, never confirmation of a discard.
// Missing river pixels must not erase history after the exact hand removal.
export function discardLeftHand(decision,before,after){
 const match=/^(?:PLAY|LIZHI) ([WBT][0-9]|Z[1-7])$/.exec(decision?.output?.response??'');
 if(!match||!before?.hand?.complete||!after?.hand?.complete)return false;
 if(sorted(decision.visibleHand)===sorted(after.hand.tiles.map(t=>t.tile)))return false;
 const river=before.rivers?.self;
 if(!river?.complete)return false;
 const projected={...after,rivers:{...after.rivers,self:{complete:true,tiles:[...river.tiles,{tile:match[1],sideways:true}]}}};
 try{verifyDiscard(decision,before,projected);return true;}catch{return false;}
}
export function verifyDiscard(decision,before,after){
  const match=/^(?:PLAY|LIZHI) ([WBT][0-9]|Z[1-7])$/.exec(decision.output.response);
  if(!match||!before.hand.complete||!after.hand.complete)
    throw Error('Complete ordinary-discard evidence required');
  const oldRiver=before.rivers.self,newRiver=after.rivers.self;
  if(!oldRiver.complete||!newRiver.complete)throw Error('Incomplete own river');
  const old=oldRiver.tiles.map(t=>t.tile),next=newRiver.tiles.map(t=>t.tile);
  if(next.length!==old.length+1||old.some((t,i)=>t!==next[i])||next.at(-1)!==match[1])
    throw Error('Own river does not confirm the requested discard');
  if(decision.output.response.startsWith('LIZHI ')&&newRiver.tiles.at(-1).sideways!==true)
    throw Error('Riichi declaration tile is not sideways');
  const hand=[...decision.visibleHand],index=hand.indexOf(match[1]);
  if(index<0)throw Error('Discard absent from decision hand');
  hand.splice(index,1);
  let visible=after.hand.tiles.map(t=>t.tile),nextDraw=null;
  if(visible.length===hand.length+1){
    const tiles=after.hand.tiles;
    // The turn lamp blinks off. A missing lamp is not an opposing turn:
    // require the independently visible separated draw and exact other tiles.
    const pitches=tiles.slice(1,-1).map((t,i)=>t.center[0]-tiles[i].center[0]).filter(x=>x>0).sort((a,b)=>a-b);
    const pitch=pitches[Math.floor(pitches.length/2)];
    if(tiles.length<2||!pitch||tiles.at(-1).center[0]-tiles.at(-2).center[0]<pitch*1.18)
      throw Error('Extra tile lacks a separately visible own draw');
    nextDraw=visible.pop();
  }
  if(sorted(hand)!==sorted(visible))throw Error('Hand removal does not match the decision');
  return {action:decision.output.response,gameConfirmed:true,nextDraw,
    before:before.id,after:after.id};
}

// A discarded tile can disappear from our river when another player calls it.
// Prove this local effect without requiring unrelated rivers to be complete.
export function verifyCalledDiscard(decision,before,after){
 const m=/^PLAY ([WBT][0-9]|Z[1-7])$/.exec(decision.output.response);
 const a=before.round,b=after.round;
 if(!m||!a?.seat_identity?.verified||!b?.seat_identity?.verified||
  a.wind!==b.wind||a.hand_number.value!==b.hand_number.value||a.counters.honba!==b.counters.honba||
  JSON.stringify(a.seat_identity.seats)!==JSON.stringify(b.seat_identity.seats))throw Error('Called discard identity unverified');
 const river=after.rivers?.self,old=before.rivers?.self;
 if(!old?.complete||!river?.complete||old.tiles.map(t=>t.tile).join(' ')!==river.tiles.map(t=>t.tile).join(' '))throw Error('Called discard river changed');
 let proven=false;
 for(const p of ['right','opposite','left']){
  if(!before.opponent_melds?.[p]?.complete||!after.opponent_melds?.[p]?.complete)continue;
  const prior=canonicalMelds(before,p,before.opponent_melds[p]);
  const added=canonicalMelds(after,p,after.opponent_melds[p]);
  for(const meld of prior){const i=added.findIndex(x=>JSON.stringify(x)===JSON.stringify(meld));if(i<0)throw Error('Prior meld changed');added.splice(i,1);}
  if(added.length===1&&['CHI','PENG','GANG'].includes(added[0].kind)&&added[0].from===a.seat_identity.seats.self&&added[0].tiles[added[0].calledIndex]===m[1])proven=true;
 }
 if(!proven)throw Error('No new sourced meld proves discard');
 // Reuse exact hand-removal and separated-next-draw checks, with an explicitly
 // projected river entry justified solely by the newly visible called tile.
 const projected={...after,rivers:{...after.rivers,self:{...river,tiles:[...old.tiles,{tile:m[1],sideways:false}]}}};
 return {...verifyDiscard(decision,before,projected),source:'new-opponent-meld',called:true};
}

// A timed-out input may be replaced by the client's discard. Preserve history
// and commit the actual visible effect instead of rebuilding the hand.
export function replacedDiscard(decision,before,after){
 if(!/^(PLAY|LIZHI) /.test(decision.output.response))return null;
 const old=before.rivers?.self,next=after.rivers?.self;
 if(!old?.complete||!next?.complete||next.tiles.length!==old.tiles.length+1)return null;
 if(old.tiles.some((t,i)=>t.tile!==next.tiles[i].tile))return null;
 const tile=next.tiles.at(-1),action=`${tile.sideways===true?'LIZHI':'PLAY'} ${tile.tile}`;
 if(action===decision.output.response)return null;
 const actual={...decision,output:{...decision.output,response:action}};
 try{verifyDiscard(actual,before,after);}catch{return null;}
 return {requested:decision.output.response,actual:action,decision:actual};
}
