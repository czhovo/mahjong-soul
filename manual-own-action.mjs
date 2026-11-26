import {GAME} from './game-rules.mjs';
import {roundIdentity} from './round-boundary.mjs';
import {canonicalMelds} from './meld-events.mjs';
import {applyPublicEvent,assertVisibleHand} from './hand-ledger.mjs';
import {confirmedNorthStock} from './kita-evidence.mjs';
import {hasSeparatedDraw} from './draw-separation.mjs';

const norm=t=>typeof t==='string'&&/^[WBT]0$/.test(t)?t[0]+'5':t;
const sameMultiset=(a,b)=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
const meldKey=m=>JSON.stringify([m.kind,[...m.tiles].sort(),m.calledIndex??null,m.from??null]);

function multisetSubtract(source,toRemove){
  const out=[...source];
  for(const t of toRemove){
    const i=out.indexOf(t);
    if(i<0)return null;
    out.splice(i,1);
  }
  return out;
}

function multisetDiff(target,base){
  const rem=[...target];
  for(const t of base){
    const i=rem.indexOf(t);
    if(i<0)return null;
    rem.splice(i,1);
  }
  return rem;
}

function verifiedOpponentDiscards(before,after,seats,lastPlayer){
  const start=Number.isInteger(lastPlayer)?lastPlayer:seats.self;
  const additions=[];
  for(let step=1;step<GAME.players;step++){
    const seat=(start+step)%GAME.players;
    if(seat===seats.self)break;
    const pos=GAME.positions.find(p=>seats[p]===seat);
    if(!pos)continue;
    const a=before?.rivers?.[pos],b=after?.rivers?.[pos];
    if(!a?.complete||!b?.complete)continue;
    if(b.tiles.length<a.tiles.length||a.tiles.some((t,i)=>t.tile!==b.tiles[i]?.tile))continue;
    for(const t of b.tiles.slice(a.tiles.length)){
      if(!t.color?.verified||t.tracking||typeof t.sideways!=='boolean')return null;
      additions.push({state:`3 ${seat} DRAW`,validact:null});
      additions.push({state:`3 ${seat} ${t.sideways?'LIZHI':'PLAY'} ${t.tile}`,validact:null});
    }
  }
  return additions;
}

function validateSequence(ledger,requests,expectedVisibleHand){
  let cur=structuredClone(ledger);
  for(const req of requests)cur=applyPublicEvent(cur,req);
  assertVisibleHand(cur,expectedVisibleHand);
  return cur;
}

function ownRiverAddition(before,after){
  const a=before?.rivers?.self,b=after?.rivers?.self;
  if(!a?.complete||!b?.complete)return null;
  if(b.tiles.length!==a.tiles.length+1)return null;
  if(a.tiles.some((t,i)=>t.tile!==b.tiles[i]?.tile||t.sideways!==b.tiles[i]?.sideways))return null;
  const tile=b.tiles.at(-1);
  if(!tile?.color?.verified||tile.tracking||typeof tile.sideways!=='boolean')return null;
  return tile;
}

function opponentCalledOurDiscard(before,after,selfSeat){
  for(const p of GAME.opponents){
    const a=before?.opponent_melds?.[p],b=after?.opponent_melds?.[p];
    if(!a?.complete||!b?.complete)continue;
    const oldM=canonicalMelds(before,p,a),newM=canonicalMelds(after,p,b);
    if(newM.length!==oldM.length+1)continue;
    const added=newM.filter(m=>!oldM.some(o=>meldKey(o)===meldKey(m)));
    if(added.length===1&&['CHI','PENG','GANG'].includes(added[0].kind)&&added[0].from===selfSeat&&Number.isInteger(added[0].calledIndex)){
      return {position:p,meld:added[0],calledTile:added[0].tiles[added[0].calledIndex]};
    }
  }
  return null;
}

function diffOwnMelds(before,after){
  if(!before?.own_melds?.complete||!after?.own_melds?.complete)return null;
  if(after.own_melds.groups.some(g=>g.estimated||g.tracking))return null;
  const oldM=canonicalMelds(before,'self',before.own_melds);
  const newM=canonicalMelds(after,'self',after.own_melds);
  if(newM.length===oldM.length){
    // Check for exactly one PENG -> BUGANG upgrade.
    const removed=oldM.filter(o=>!newM.some(n=>meldKey(n)===meldKey(o)));
    const added=newM.filter(n=>!oldM.some(o=>meldKey(o)===meldKey(n)));
    if(removed.length===1&&added.length===1&&removed[0].kind==='PENG'&&added[0].kind==='BUGANG'&&
       norm(removed[0].tiles[0])===norm(added[0].tiles[0])){
      const extra=multisetSubtract(added[0].tiles,removed[0].tiles);
      if(extra?.length===1)return {type:'BUGANG',group:added[0],previous:removed[0],addedTile:extra[0]};
    }
    return {type:'NONE'};
  }
  if(newM.length===oldM.length+1){
    const remaining=[...newM];
    for(const o of oldM){
      const idx=remaining.findIndex(n=>meldKey(n)===meldKey(o));
      if(idx<0)return null;
      remaining.splice(idx,1);
    }
    if(remaining.length===1)return {type:remaining[0].kind,group:remaining[0]};
  }
  return null;
}

/**
 * Build the post-anchor baseline frame for manual-action diffing when
 * `LiveCycle.publicFrame` is null. `anchor.before` is captured BEFORE
 * `anchor.decision` (PLAY / LIZHI) was discarded, whereas `session.ledger`
 * already has `anchor.decision` committed. Projecting the confirmed anchor
 * discard onto `anchor.before` prevents `detectManualOwnAction` from
 * misclassifying the bot's own confirmed discard as a duplicate manual action.
 */
export function manualActionBaseFrame(anchor,afterFrame,seat){
  const base=anchor?.before;
  const response=anchor?.decision?.output?.response;
  if(!base||typeof response!=='string')return base;
  const [kind,tile,...rest]=response.trim().split(/\s+/);
  if(!['PLAY','LIZHI'].includes(kind)||!tile||rest.length)return base;

  const next={
    ...base,
    hand:base.hand?{...base.hand,tiles:base.hand.tiles?[...base.hand.tiles]:[]}:base.hand,
    rivers:base.rivers?{...base.rivers}:base.rivers,
    opponent_melds:base.opponent_melds?{...base.opponent_melds}:base.opponent_melds,
    round:base.round
      ?{...base.round,counters:base.round.counters?{...base.round.counters}:base.round.counters}
      :base.round,
  };

  if(next.hand?.tiles){
    const idx=next.hand.tiles.findIndex(t=>t.tile===tile);
    if(idx>=0)next.hand.tiles.splice(idx,1);
  }

  const selfRiver=base.rivers?.self;
  if(selfRiver?.complete&&Array.isArray(selfRiver.tiles)){
    const afterSelf=afterFrame?.rivers?.self;
    const riverUnchanged=afterSelf?.complete&&Array.isArray(afterSelf.tiles)&&afterSelf.tiles.length===selfRiver.tiles.length;
    const calledAway=riverUnchanged&&Number.isInteger(seat)?opponentCalledOurDiscard(base,afterFrame,seat):null;
    if(calledAway&&calledAway.calledTile===tile&&afterFrame?.opponent_melds?.[calledAway.position]){
      next.opponent_melds[calledAway.position]=structuredClone(afterFrame.opponent_melds[calledAway.position]);
    }else{
      next.rivers.self={
        ...selfRiver,
        tiles:[
          ...selfRiver.tiles,
          {tile,sideways:kind==='LIZHI',color:{verified:true},tracking:false},
        ],
      };
    }
  }

  if(kind==='LIZHI'&&Number.isInteger(next.round?.counters?.riichi_sticks)&&
     afterFrame?.round?.counters?.riichi_sticks===next.round.counters.riichi_sticks+1){
    next.round.counters.riichi_sticks+=1;
  }
  return next;
}

/**
 * Incrementally detect and verify a user-performed manual own action between
 * `before` and `after`, strictly validated via `applyPublicEvent` + `assertVisibleHand`.
 *
 * Returns null if no manual own action occurred, `{kind:'wait_manual_selection'}` if
 * the user is currently inside a manual riichi/post-call discard selection overlay,
 * or `{verified:true, kind:'manual_own_action', action, requests, commitRequests, decisionEvent,
 *       needsDecision, rinshanVerified, acceptedRiichi, expectedCommitHand}`.
 */
export function detectManualOwnAction(before,after,session,{allowPendingBase=false,inSpecial=false}={}){
  if(!before||!after||!session?.ledger?.hand)return null;
  if(!allowPendingBase&&session.pending)return null;
  const idA=roundIdentity(before),idB=roundIdentity(after);
  if(!idA||!idB||JSON.stringify(idA)!==JSON.stringify(idB))return null;
  if(!after.hand?.complete||after.hand.rejected?.length||!after.own_melds?.complete)return null;

  const seats=idB.seats,seat=seats.self;
  const ledger=session.ledger;
  const beforeHand=[...ledger.hand];
  const afterHand=after.hand.tiles.map(t=>t.tile);
  const oldMeldCount=before.own_melds?.complete?before.own_melds.groups.length:Math.round((13-beforeHand.length)/3);
  const newMeldCount=after.own_melds.groups.length;
  const newBaseLen=13-3*newMeldCount;

  // User manually clicked Riichi (or call) and is currently picking their discard in the selection overlay.
  if(!inSpecial&&(after.selection?.verified||after.call_choices?.verified)&&newMeldCount===oldMeldCount){
    return {kind:'wait_manual_selection',reason:'检测到用户正在手动选择立直/鸣牌弃牌，静候完成'};
  }

  const meldDelta=diffOwnMelds(before,after);
  const oppPrefix=verifiedOpponentDiscards(before,after,seats,ledger.lastPlayer)??[];

  // 1. Manual CHI / PENG
  if(meldDelta&&(meldDelta.type==='CHI'||meldDelta.type==='PENG')){
    const g=meldDelta.group;
    if(!Number.isInteger(g.calledIndex)||!Number.isInteger(g.from)||g.from===seat)return null;
    if(meldDelta.type==='CHI'&&(GAME.sanma||g.from!==(seat+GAME.players-1)%GAME.players))return null;
    const called=g.tiles[g.calledIndex];
    const supplied=g.tiles.filter((_,i)=>i!==g.calledIndex);
    const afterCallHand=multisetSubtract(beforeHand,supplied);
    if(!afterCallHand)return null;

    const prefix=[];
    const alreadyTrigger=ledger.lastPlayer===g.from&&ledger.lastDiscard===called;
    if(!alreadyTrigger){
      // Preserve any verified opponent discards up to the trigger, or emit the called discard.
      const triggerInPrefix=oppPrefix.at(-1)?.state===`3 ${g.from} PLAY ${called}`||oppPrefix.at(-1)?.state===`3 ${g.from} LIZHI ${called}`;
      if(triggerInPrefix)prefix.push(...oppPrefix);
      else prefix.push({state:`3 ${g.from} DRAW`,validact:null},{state:`3 ${g.from} PLAY ${called}`,validact:null});
    }

    // 1a. Called, post-call discard NOT yet made -> hand over to engine immediately!
    if(afterHand.length===newBaseLen+1&&sameMultiset(afterHand,afterCallHand)){
      const decisionEvent={state:`3 ${seat} ${g.kind} ${called} ${supplied.join(' ')}`,validact:'PLAY',observedCallBeforeDiscard:true};
      try{
        const afterPrefix=validateSequence(ledger,prefix,beforeHand);
        validateSequence(afterPrefix,[decisionEvent],afterHand);
      }catch{return null;}
      return {
        verified:true,kind:'manual_own_action',
        action:`${g.kind} ${called} ${supplied.join(' ')}`,
        requests:[...prefix,decisionEvent],
        commitRequests:prefix,
        decisionEvent,
        expectedCommitHand:beforeHand,
        needsDecision:true,
        rinshanVerified:false,
        acceptedRiichi:null,
      };
    }

    // 1b. Called AND post-call discard Y already made -> commit complete 7-token call event!
    if(afterHand.length===newBaseLen){
      const riverTile=ownRiverAddition(before,after);
      const diff=multisetDiff(afterCallHand,afterHand);
      if(diff?.length!==1)return null;
      const discardY=diff[0];
      if(riverTile&&riverTile.tile!==discardY)return null;
      const callEvt={state:`3 ${seat} ${g.kind} ${called} ${supplied.join(' ')} ${discardY}`,validact:null};
      const reqs=[...prefix,callEvt];
      try{validateSequence(ledger,reqs,afterHand);}catch{return null;}
      return {
        verified:true,kind:'manual_own_action',
        action:`${g.kind} ${called} ${supplied.join(' ')} ${discardY}`,
        requests:reqs,
        commitRequests:reqs,
        decisionEvent:null,
        expectedCommitHand:afterHand,
        needsDecision:false,
        rinshanVerified:false,
        acceptedRiichi:null,
      };
    }
    return null;
  }

  // 2. Manual ANGANG / BUGANG / GANG
  if(meldDelta&&['ANGANG','BUGANG','GANG'].includes(meldDelta.type)){
    const g=meldDelta.group;
    let prefix=[];
    let handAfterKan=null;
    let kanEvent=null;
    let actionLabel='';

    if(meldDelta.type==='ANGANG'){
      const targetNorm=norm(g.tiles[0]);
      const copiesInBefore=beforeHand.filter(t=>norm(t)===targetNorm);
      let drawnTile=null;
      if(copiesInBefore.length===4){
        handAfterKan=multisetSubtract(beforeHand,copiesInBefore);
      }else if(copiesInBefore.length===3&&beforeHand.length===13-3*oldMeldCount){
        // Infer the 4th tile drawn immediately before manual ANGANG (preserve red-5 if visible in g.tiles).
        const redNeeded=g.tiles.some(t=>/^[WBT]0$/.test(t))&&!copiesInBefore.some(t=>/^[WBT]0$/.test(t));
        drawnTile=redNeeded?targetNorm[0]+'0':targetNorm;
        prefix=[...oppPrefix,{state:`2 ${drawnTile}`,validact:null}];
        handAfterKan=multisetSubtract([...beforeHand,drawnTile],[...copiesInBefore,drawnTile]);
      }else return null;
      const kanTile=copiesInBefore.includes(targetNorm)?targetNorm:(copiesInBefore[0]??targetNorm);
      kanEvent={state:`3 ${seat} ANGANG ${kanTile}`,validact:null};
      actionLabel=`ANGANG ${kanTile}`;
    }else if(meldDelta.type==='BUGANG'){
      const addedTile=meldDelta.addedTile;
      if(beforeHand.length===14-3*oldMeldCount){
        const phys=beforeHand.includes(addedTile)?addedTile:beforeHand.find(t=>norm(t)===norm(addedTile));
        if(!phys)return null;
        handAfterKan=multisetSubtract(beforeHand,[phys]);
        kanEvent={state:`3 ${seat} BUGANG ${phys}`,validact:null};
        actionLabel=`BUGANG ${phys}`;
      }else if(beforeHand.length===13-3*oldMeldCount){
        // Either we just drew `addedTile` and bugang'd it, or we drew D and bugang'd an existing copy in hand.
        const hasCopy=beforeHand.find(t=>norm(t)===norm(addedTile));
        let drawnTile=addedTile;
        if(hasCopy&&afterHand.length===newBaseLen+1){
          // Check if remaining hand after removing `hasCopy` differs from afterHand by 2 tiles (draw + rinshan) - ambiguous;
          // If afterHand without last tile equals beforeHand - [hasCopy] + [D], or simply drawnTile === addedTile:
          if(sameMultiset(afterHand.slice(0,-1),beforeHand)){
            drawnTile=addedTile;
          }
        }
        prefix=[...oppPrefix,{state:`2 ${drawnTile}`,validact:null}];
        handAfterKan=multisetSubtract([...beforeHand,drawnTile],[addedTile]);
        kanEvent={state:`3 ${seat} BUGANG ${addedTile}`,validact:null};
        actionLabel=`BUGANG ${addedTile}`;
      }else return null;
    }else if(meldDelta.type==='GANG'){
      if(!Number.isInteger(g.calledIndex)||!Number.isInteger(g.from)||g.from===seat)return null;
      const called=g.tiles[g.calledIndex];
      const copies=beforeHand.filter(t=>norm(t)===norm(called));
      if(copies.length!==3)return null;
      if(!(ledger.lastPlayer===g.from&&ledger.lastDiscard===called)){
        const triggerInPrefix=oppPrefix.at(-1)?.state===`3 ${g.from} PLAY ${called}`||oppPrefix.at(-1)?.state===`3 ${g.from} LIZHI ${called}`;
        if(triggerInPrefix)prefix=[...oppPrefix];
        else prefix=[{state:`3 ${g.from} DRAW`,validact:null},{state:`3 ${g.from} PLAY ${called}`,validact:null}];
      }
      handAfterKan=multisetSubtract(beforeHand,copies);
      kanEvent={state:`3 ${seat} GANG ${called}`,validact:null};
      actionLabel=`GANG ${called}`;
    }

    if(!handAfterKan||!kanEvent)return null;
    const baseReqs=[...prefix,kanEvent];

    // 2a. Rinshan draw observed (hand has 14 - 3*m tiles), not yet discarded -> hand to engine with rinshan_verified!
    if(afterHand.length===handAfterKan.length+1){
      const diff=multisetDiff(afterHand,handAfterKan);
      if(diff?.length!==1)return null;
      const rinshan=diff[0];
      const decisionEvent={state:`2 ${rinshan}`,validact:'PLAY'};
      try{
        const afterKan=validateSequence(ledger,baseReqs,handAfterKan);
        validateSequence(afterKan,[decisionEvent],afterHand);
      }catch{return null;}
      return {
        verified:true,kind:'manual_own_action',
        action:actionLabel,
        requests:[...baseReqs,decisionEvent],
        commitRequests:baseReqs,
        decisionEvent,
        expectedCommitHand:handAfterKan,
        needsDecision:true,
        rinshanVerified:true,
        acceptedRiichi:null,
      };
    }

    // 2b. Rinshan draw AND post-rinshan discard already observed (own river grew by 1)!
    const postDiscard=ownRiverAddition(before,after);
    if(afterHand.length===handAfterKan.length&&postDiscard){
      const diff=multisetDiff([...afterHand,postDiscard.tile],handAfterKan);
      if(diff?.length!==1)return null;
      const rinshan=diff[0];
      const discardKind=postDiscard.sideways?'LIZHI':'PLAY';
      const reqs=[...baseReqs,{state:`2 ${rinshan}`,validact:null},{state:`3 ${seat} ${discardKind} ${postDiscard.tile}`,validact:null}];
      try{validateSequence(ledger,reqs,afterHand);}catch{return null;}
      const riichiPaid=discardKind==='LIZHI'&&after.round?.counters?.riichi_sticks===before.round?.counters?.riichi_sticks+1;
      return {
        verified:true,kind:'manual_own_action',
        action:`${actionLabel} → ${discardKind} ${postDiscard.tile}`,
        requests:reqs,
        commitRequests:reqs,
        decisionEvent:null,
        expectedCommitHand:afterHand,
        needsDecision:false,
        rinshanVerified:false,
        acceptedRiichi:riichiPaid?{seat,deposit:1000}:null,
      };
    }

    // 2c. Kan observed mid-animation before rinshan draw arrives -> commit kan only!
    if(afterHand.length===handAfterKan.length&&sameMultiset(afterHand,handAfterKan)){
      try{validateSequence(ledger,baseReqs,handAfterKan);}catch{return null;}
      return {
        verified:true,kind:'manual_own_action',
        action:actionLabel,
        requests:baseReqs,
        commitRequests:baseReqs,
        decisionEvent:null,
        expectedCommitHand:handAfterKan,
        needsDecision:false,
        rinshanVerified:false,
        acceptedRiichi:null,
      };
    }
    return null;
  }

  // 3. Sanma Manual KITA Z4 (single or chained, with replacement draw and optional discard)
  if(GAME.sanma&&meldDelta?.type==='NONE'&&Number.isInteger(before.kita?.self?.count)&&
     Number.isInteger(after.kita?.self?.count)&&after.kita.self.count>before.kita.self.count&&
     confirmedNorthStock(after.kita.self)){
    const n=after.kita.self.count-before.kita.self.count;
    if(n>=1&&n<=4){
      const riverTile=ownRiverAddition(before,after);
      const baseLen=13-3*newMeldCount;
      // Case 3a: Before hand had 14-3m (draw already in ledger), after hand has 14-3m (replacement ready) or 13-3m (also discarded)
      if(beforeHand.length===baseLen+1){
        const targetPool=riverTile?[...afterHand,riverTile.tile]:[...afterHand];
        const unseen=multisetDiff([...targetPool,...Array(n).fill('Z4')],beforeHand);
        if(unseen&&unseen.length===n){
          // Last tile is the detached replacement draw (or the only unseen tile when n===1).
          const finalDraw=riverTile?unseen.at(-1):afterHand.at(-1);
          const earlier=multisetSubtract(unseen,[finalDraw]);
          if(earlier!==null&&(earlier.length<=1||new Set(earlier).size===1)){
            const reqs=[];
            for(const d of earlier)reqs.push({state:`3 ${seat} KITA Z4`,validact:null},{state:`2 ${d}`,validact:null});
            reqs.push({state:`3 ${seat} KITA Z4`,validact:null});
            if(riverTile){
              const discardKind=riverTile.sideways?'LIZHI':'PLAY';
              reqs.push({state:`2 ${finalDraw}`,validact:null},{state:`3 ${seat} ${discardKind} ${riverTile.tile}`,validact:null});
              try{validateSequence(ledger,reqs,afterHand);}catch{return null;}
              const riichiPaid=discardKind==='LIZHI'&&after.round?.counters?.riichi_sticks===before.round?.counters?.riichi_sticks+1;
              return {
                verified:true,kind:'manual_own_action',
                action:n>1?`KITA Z4 ×${n} → ${discardKind} ${riverTile.tile}`:`KITA Z4 → ${discardKind} ${riverTile.tile}`,
                requests:reqs,commitRequests:reqs,decisionEvent:null,
                expectedCommitHand:afterHand,needsDecision:false,rinshanVerified:false,
                acceptedRiichi:riichiPaid?{seat,deposit:1000}:null,
              };
            }
            const decisionEvent={state:`2 ${finalDraw}`,validact:'PLAY'};
            const expectedCommit=multisetSubtract(afterHand,[finalDraw]);
            if(expectedCommit){
              try{
                const afterK=validateSequence(ledger,reqs,expectedCommit);
                validateSequence(afterK,[decisionEvent],afterHand);
              }catch{return null;}
              return {
                verified:true,kind:'manual_own_action',
                action:n>1?`KITA Z4 ×${n}`:'KITA Z4',
                requests:[...reqs,decisionEvent],commitRequests:reqs,decisionEvent,
                expectedCommitHand:expectedCommit,needsDecision:true,rinshanVerified:true,
                acceptedRiichi:null,
              };
            }
          }
        }
      }
      // Case 3b: Before hand had 13-3m (draw not yet in ledger), user drew and extracted n times
      if(beforeHand.length===baseLen&&!riverTile&&afterHand.length===baseLen+1){
        const unseen=multisetDiff([...afterHand,...Array(n).fill('Z4')],beforeHand);
        if(unseen&&unseen.length===n+1){
          const finalDraw=afterHand.at(-1);
          const earlier=multisetSubtract(unseen,[finalDraw]);
          // Deterministic when all earlier draws are identical (e.g. Z4 or single draw when n===1).
          if(earlier!==null&&(earlier.length===1||new Set(earlier).size===1)){
            const reqs=[...oppPrefix];
            for(const d of earlier)reqs.push({state:`2 ${d}`,validact:null},{state:`3 ${seat} KITA Z4`,validact:null});
            const decisionEvent={state:`2 ${finalDraw}`,validact:'PLAY'};
            const expectedCommit=multisetSubtract(afterHand,[finalDraw]);
            if(expectedCommit){
              try{
                const afterK=validateSequence(ledger,reqs,expectedCommit);
                validateSequence(afterK,[decisionEvent],afterHand);
              }catch{return null;}
              return {
                verified:true,kind:'manual_own_action',
                action:n>1?`KITA Z4 ×${n}`:'KITA Z4',
                requests:[...reqs,decisionEvent],commitRequests:reqs,decisionEvent,
                expectedCommitHand:expectedCommit,needsDecision:true,rinshanVerified:true,
                acceptedRiichi:null,
              };
            }
          }
        }
      }
    }
  }

  // 4. Manual PLAY or Manual LIZHI (visible in own river OR immediately called by opponent)
  if(meldDelta?.type==='NONE'){
    const riverTile=ownRiverAddition(before,after);
    const calledAway=!riverTile?opponentCalledOurDiscard(before,after,seat):null;
    if(!riverTile&&!calledAway)return null;
    if(calledAway&&ledger.lastPlayer===seat&&ledger.lastDiscard===calledAway.calledTile&&
       !oppPrefix.some(r=>Number(r.state.split(' ')[1])!==seats[calledAway.position]))return null;

    const actionKind=riverTile?.sideways?'LIZHI':'PLAY';
    const discardTile=riverTile?riverTile.tile:calledAway.calledTile;
    let concealedAfter=afterHand;
    let nextDraw=null;
    if(afterHand.length===newBaseLen+1&&hasSeparatedDraw(after.hand.tiles,{priorTiles:before.hand?.tiles})){
      nextDraw=afterHand.at(-1);
      concealedAfter=afterHand.slice(0,-1);
    }
    if(concealedAfter.length!==newBaseLen)return null;

    let reqs=null;
    if(beforeHand.length===newBaseLen+1){
      // Own draw was already recorded in ledger.
      const rem=multisetSubtract(beforeHand,[discardTile]);
      if(rem&&sameMultiset(rem,concealedAfter)){
        reqs=[{state:`3 ${seat} ${actionKind} ${discardTile}`,validact:null}];
      }
    }else if(beforeHand.length===newBaseLen){
      // Infer drawn tile D uniquely from multiset conservation: concealedAfter + [discardTile] === beforeHand + [D].
      const diff=multisetDiff([...concealedAfter,discardTile],beforeHand);
      if(diff?.length===1){
        const drawnTile=diff[0];
        reqs=[...oppPrefix,{state:`2 ${drawnTile}`,validact:null},{state:`3 ${seat} ${actionKind} ${discardTile}`,validact:null}];
      }
    }
    if(!reqs)return null;
    try{validateSequence(ledger,reqs,concealedAfter);}catch{return null;}

    const riichiPaid=actionKind==='LIZHI'&&after.round?.counters?.riichi_sticks===before.round?.counters?.riichi_sticks+1;
    const decisionEvent=nextDraw?{state:`2 ${nextDraw}`,validact:'PLAY'}:null;
    return {
      verified:true,kind:'manual_own_action',
      action:`${actionKind} ${discardTile}`,
      requests:decisionEvent?[...reqs,decisionEvent]:reqs,
      commitRequests:reqs,
      decisionEvent,
      expectedCommitHand:concealedAfter,
      needsDecision:!!decisionEvent,
      rinshanVerified:false,
      acceptedRiichi:riichiPaid?{seat,deposit:1000}:null,
      calledAway:calledAway?{position:calledAway.position,tile:calledAway.calledTile}:null,
    };
  }

  return null;
}
