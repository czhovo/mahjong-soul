import {GAME} from './game-rules.mjs';
import {AutoWin} from './auto-win.mjs';
import {roundIdentity} from './round-boundary.mjs';
import {hasTsumoHand,hasRonHand} from './tsumo-guard.mjs';
import {declaredSeats} from './confirmed-riichi.mjs';
import {shapeWaits} from './tenpai-hint.mjs';

const norm=t=>typeof t==='string'&&/^[WBT]0$/.test(t)?t[0]+'5':t;

function roundKeyOf(frame){
  const id=roundIdentity(frame);
  return id?JSON.stringify(id):null;
}

function riverCountsOf(frame){
  const out={};
  for(const p of GAME.positions){
    const r=frame?.rivers?.[p];
    out[p]=r?.complete?r.tiles.length:null;
  }
  return out;
}

function meldCountsOf(frame){
  const out={};
  for(const p of GAME.positions){
    const m=p==='self'?frame?.own_melds:frame?.opponent_melds?.[p];
    out[p]=m?.complete?(m.groups?.length??0):null;
  }
  return out;
}

function remainingOf(frame){
  const r=frame?.round?.remaining;
  if(!r)return null;
  const v=r.estimated?r.observedValue:r.value;
  return Number.isInteger(v)?v:null;
}

function sameTileMultiset(a,b){
  if(!Array.isArray(a)||!Array.isArray(b)||a.length!==b.length)return false;
  return JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
}

function tableProgressed(wait,frame){
  const rem=remainingOf(frame);
  if(Number.isInteger(wait.initialRemaining)&&Number.isInteger(rem)&&rem<wait.initialRemaining)return true;
  const melds=meldCountsOf(frame);
  for(const p of GAME.positions){
    if(Number.isInteger(wait.initialMeldCounts[p])&&Number.isInteger(melds[p])&&melds[p]>wait.initialMeldCounts[p])return true;
  }
  // Do NOT treat opponent river count increases alone as early progression: a transiently occluded
  // river ("Incomplete river") recovering 0.3s later would otherwise bypass waitMs during a real
  // auto-tsumo/auto-ron animation and falsely trigger Stage 3/4 idle_until_next_round.
  return false;
}

function extractOpponentDiscard(event,selfSeat){
  const w=(event?.state??'').trim().split(/\s+/);
  if(w[0]!=='3')return null;
  const actor=Number(w[1]);
  if(Number.isInteger(selfSeat)&&actor===selfSeat)return null;
  const kind=w[2];
  if((kind==='PLAY'||kind==='LIZHI')&&w[3])return {actor,tile:w[3]};
  if((kind==='CHI'||kind==='PENG')&&w.length===7&&w[6])return {actor,tile:w[6]};
  return null;
}

/**
 * Four-stage auto-win guard state machine (never routes winning through the decision engine):
 *  Stage 1: Quietly wait for auto-win settlement (`waiting_auto_win_settlement`).
 *  Stage 2: If the round continues or stalls (>=1200ms & >=2 frames), check `frame.auto_win`;
 *           if OFF, click AutoWin to enable and keep waiting.
 *  Stage 3: If `auto_win` is already ON (or remains unsettled after enabling), trigger a
 *           `force_hand_rescan: true` full hand recognition pass. If the rescanned hand differs
 *           and is no longer a winning hand, reconcile the visible hand and resume normal play.
 *  Stage 4: If the full rescan confirms the hand truly is a winning hand while auto-win is ON
 *           yet no settlement occurred, bind `idle_until_next_round` to this round identity and
 *           stay completely silent until settlement, round change, or match end clears it.
 */
export class AutoWinGuard {
  constructor({waitMs=3000,noticeMs=4000,autoWin=new AutoWin()}={}){
    this.waitMs=waitMs;
    this.noticeMs=noticeMs;
    this.autoWin=autoWin;
    this.reset();
  }

  reset(){
    this.activeRoundKey=null;
    this.idleRoundKey=null;
    this.wait=null;
    this.lastRiverCounts=null;
    this.tempFuriten=false;
    this.riichiMissedWin=false;
  }

  isIdleFor(frame){
    if(!this.idleRoundKey)return false;
    const key=roundKeyOf(frame);
    return key!==null&&key===this.idleRoundKey;
  }

  syncRound(frame){
    if(!frame)return;
    if(frame.terminal_phase?.name==='match_end'||frame.settlement?.complete||frame.result_page?.kind==='own-win-settlement'){
      this.reset();
      return;
    }
    const key=roundKeyOf(frame);
    if(!key)return;
    if(this.activeRoundKey&&this.activeRoundKey!==key){
      this.reset();
    }
    this.activeRoundKey=key;
  }

  // Track same-turn / post-riichi missed wins so temporary/riichi furiten is respected.
  observePublicDiscards(frame,session,{riichi=false}={}){
    if(!frame?.hand?.complete||frame.hand.rejected?.length||!frame.own_melds?.complete)return [];
    const melds=frame.own_melds.groups??[];
    const hand=frame.hand.tiles.map(t=>t.tile);
    const rivers=riverCountsOf(frame);
    const prev=this.lastRiverCounts;
    this.lastRiverCounts=rivers;

    const seat=frame.round?.seat_identity?.seats?.self??session?.seat;
    const isRiichi=riichi===true||!!frame.rivers?.self?.tiles?.some(t=>t.sideways===true)||
      (session?.requests&&Number.isInteger(seat)&&declaredSeats(session.requests).has(seat));

    // Own turn (14-3m) or own discard clears non-riichi temporary furiten.
    if(!isRiichi&&(hand.length===14-3*melds.length||(prev&&Number.isInteger(prev.self)&&Number.isInteger(rivers.self)&&rivers.self>prev.self))){
      this.tempFuriten=false;
    }

    const freshOpponents=[];
    if(prev){
      for(const p of GAME.opponents){
        const oldLen=prev[p],nowLen=rivers[p];
        if(Number.isInteger(oldLen)&&Number.isInteger(nowLen)&&nowLen>oldLen){
          const tiles=frame.rivers?.[p]?.tiles??[];
          for(let i=oldLen;i<nowLen;i++){
            const tile=tiles[i]?.tile;
            if(tile)freshOpponents.push({position:p,tile});
          }
        }
      }
    }
    return freshOpponents;
  }

  recordMissedWaitIfNeeded(frame,discardTile,session,{riichi=false}={}){
    if(!discardTile||!frame?.hand?.complete||!frame.own_melds?.complete)return;
    const melds=frame.own_melds.groups??[];
    const hand=frame.hand.tiles.map(t=>t.tile);
    if(hand.length!==13-3*melds.length)return;
    const rawWaits=shapeWaits(hand,melds);
    const waits=rawWaits&&GAME.sanma?rawWaits.filter(w=>!/^W[2-8]$/.test(w)):rawWaits;
    if(!(waits??[]).includes(norm(discardTile)))return;
    const seat=frame.round?.seat_identity?.seats?.self??session?.seat;
    const isRiichi=riichi===true||!!frame.rivers?.self?.tiles?.some(t=>t.sideways===true)||
      (session?.requests&&Number.isInteger(seat)&&declaredSeats(session.requests).has(seat));
    if(isRiichi)this.riichiMissedWin=true;
    else this.tempFuriten=true;
  }

  async evaluate(frame,{session,adapter,reactionEvent=null,riichi=false,now=performance.now(),record=null}={}){
    this.syncRound(frame);
    if(!frame||frame.terminal_phase?.name==='match_end'||frame.settlement?.complete||frame.result_page?.kind==='own-win-settlement'){
      return {action:'none'};
    }
    const roundKey=roundKeyOf(frame);
    if(!roundKey)return {action:'none'};
    if(this.idleRoundKey&&this.idleRoundKey===roundKey){
      return {action:'idle',status:'idle_until_next_round',frame:frame.id};
    }

    const history=session?.requests??null;
    const kokushiRouteActive=adapter?.kokushiRoute?.active===true;
    const selfSeat=frame.round?.seat_identity?.seats?.self??session?.seat;
    const freshOpponents=this.observePublicDiscards(frame,session,{riichi});

    // Stage 0 -> Stage 1 detection when not already waiting.
    if(!this.wait){
      const melds=frame.own_melds?.complete?frame.own_melds.groups:null;
      const tsumo=Array.isArray(melds)&&hasTsumoHand(frame,{melds,riichi,history,kokushiRouteActive});
      if(tsumo){
        const handTiles=frame.hand.tiles.map(t=>t.tile);
        this.wait={
          kind:'tsumo',
          roundKey,
          startedAt:now,
          frames:new Set([frame.id]),
          winTile:handTiles.at(-1),
          handTiles,
          initialRemaining:remainingOf(frame),
          initialRiverCounts:riverCountsOf(frame),
          initialMeldCounts:meldCountsOf(frame),
          autoWinClickedAt:null,
          rescanAttempted:false,
          noticeEmitted:false,
        };
        return {action:'wait',status:'waiting_auto_win_settlement',winKind:'tsumo',frame:frame.id};
      }

      // Check opponent discard ron candidate (from explicit reactionEvent or newly observed opponent river tile).
      const candidates=[];
      const fromEvent=extractOpponentDiscard(reactionEvent,selfSeat);
      if(fromEvent)candidates.push(fromEvent.tile);
      for(const opp of freshOpponents){
        if(!candidates.includes(opp.tile))candidates.push(opp.tile);
      }
      if(Array.isArray(melds)&&candidates.length){
        const tempFuriten=this.tempFuriten||this.riichiMissedWin;
        for(const tile of candidates){
          if(hasRonHand(frame,tile,{melds,riichi,history,tempFuriten,kokushiRouteActive})){
            const handTiles=frame.hand.tiles.map(t=>t.tile);
            this.wait={
              kind:'ron',
              roundKey,
              startedAt:now,
              frames:new Set([frame.id]),
              winTile:tile,
              handTiles,
              initialRemaining:remainingOf(frame),
              initialRiverCounts:riverCountsOf(frame),
              initialMeldCounts:meldCountsOf(frame),
              autoWinClickedAt:null,
              rescanAttempted:false,
              noticeEmitted:false,
            };
            return {action:'wait',status:'waiting_auto_win_settlement',winKind:'ron',frame:frame.id};
          }
        }
      }
      return {action:'none'};
    }

    // Active Stage 1..4 progression.
    const wait=this.wait;
    if(frame.id)wait.frames.add(frame.id);

    // Stay completely silent during normal auto-win cut-in / settlement; only emit
    // a visible waiting notice if several seconds pass while the live hand is still unsettled.
    if(!wait.noticeEmitted&&frame.hand?.complete&&now-wait.startedAt>=this.noticeMs){
      wait.noticeEmitted=true;
      await record?.({kind:'auto_win_waiting_settlement',winKind:wait.kind,winTile:wait.winTile,waitedMs:Math.round(now-wait.startedAt),frame:frame.id});
    }

    // If auto-win was clicked in Stage 2, keep driving its 2-frame confirmation gate.
    if(wait.autoWinClickedAt!==null){
      const sent=await this.autoWin.update(frame,adapter,{winDecision:true});
      if(sent){
        wait.autoWinClickedAt=now;
        wait.startedAt=now;
        wait.frames=new Set([frame.id]);
        await record?.({kind:'auto_win_enable_sent',frame:frame.id});
        return {action:'auto_win_toggle',status:'auto_win_sent',frame:frame.id};
      }
      if(this.autoWin.confirmedNow){
        await record?.({kind:'auto_win_confirmed',frame:frame.id});
        // Give the freshly confirmed auto-win a brief settle window unless table already progressed.
        if(!tableProgressed(wait,frame)&&now-wait.autoWinClickedAt<this.waitMs){
          return {action:'wait',status:'waiting_auto_win_settlement',winKind:wait.kind,frame:frame.id};
        }
      }
    }

    const progressed=tableProgressed(wait,frame);
    const stalled=now-wait.startedAt>=this.waitMs&&wait.frames.size>=2;
    if(!progressed&&!stalled){
      return {action:'wait',status:'waiting_auto_win_settlement',winKind:wait.kind,frame:frame.id};
    }

    // Stage 2: Check green auto-win switch before forced rescan.
    if(frame.auto_win?.verified&&!frame.auto_win.enabled){
      const sent=await this.autoWin.update(frame,adapter,{winDecision:true});
      if(sent){
        wait.autoWinClickedAt=now;
        wait.startedAt=now;
        wait.frames=new Set([frame.id]);
        await record?.({kind:'auto_win_enable_sent',frame:frame.id});
        return {action:'auto_win_toggle',status:'auto_win_sent',frame:frame.id};
      }
      // If AutoWin is waiting for its 2-frame OFF retry gate before re-clicking, wait briefly.
      if(wait.autoWinClickedAt!==null&&now-wait.autoWinClickedAt<this.waitMs*2){
        return {action:'wait',status:'waiting_auto_win_settlement',winKind:wait.kind,frame:frame.id};
      }
    }

    // Stage 3: Force a full concealed-hand rescan (bypassing PublicTileTail.hand_state reuse).
    // If the hand is already covered (e.g. Ron/Tsumo cut-in animation), keep waiting instead of
    // wasting ~2.7s rescanning an occluded animation frame.
    if(!frame.hand?.complete){
      return {action:'wait',status:'waiting_auto_win_settlement',winKind:wait.kind,frame:frame.id};
    }
    const meldCount=frame.hand?.meld_count??(frame.own_melds?.groups?.length??0);
    let rescanned=frame;
    if(typeof adapter?.inspect==='function'){
      rescanned=await adapter.inspect({
        meld_count:meldCount,
        phase:'auto',
        auto_meld_count:true,
        observeSettlement:true,
        force_hand_rescan:true,
      });
    }
    this.syncRound(rescanned);
    if(rescanned.terminal_phase?.name==='match_end'||rescanned.settlement?.complete||rescanned.result_page?.kind==='own-win-settlement'||roundKeyOf(rescanned)!==roundKey){
      this.wait=null;
      return {action:'recovered',rescanned};
    }

    if(!rescanned.hand?.complete||rescanned.hand.rejected?.length||!rescanned.own_melds?.complete){
      return {action:'wait',status:'waiting_auto_win_settlement',winKind:wait.kind,frame:rescanned.id};
    }

    const rescannedTiles=rescanned.hand.tiles.map(t=>t.tile);
    const rescannedMelds=rescanned.own_melds.groups??[];
    const stillWinning=wait.kind==='tsumo'
      ?hasTsumoHand(rescanned,{melds:rescannedMelds,riichi,history,kokushiRouteActive})
      :hasRonHand(rescanned,wait.winTile,{melds:rescannedMelds,riichi,history,tempFuriten:false,kokushiRouteActive});

    if(!stillWinning){
      const changed=!sameTileMultiset(wait.handTiles,rescannedTiles);
      if(session&&!session.pending&&typeof session.reconcileVisibleHand==='function'){
        const baseLen=13-3*rescannedMelds.length;
        if(rescannedTiles.length===baseLen||rescannedTiles.length===baseLen+1){
          const expected=rescannedTiles.length===baseLen+1?rescannedTiles.slice(0,-1):rescannedTiles;
          try{session.reconcileVisibleHand(expected,{frameId:rescanned.id});}catch{}
        }
      }
      if(wait.kind==='ron'&&!changed){
        this.recordMissedWaitIfNeeded(rescanned,wait.winTile,session,{riichi});
      }
      this.wait=null;
      await record?.({
        kind:'auto_win_hand_corrected',
        winKind:wait.kind,
        frame:rescanned.id,
        previous:wait.handTiles,
        current:rescannedTiles,
        changed,
      });
      return {action:'recovered',rescanned,corrected:true};
    }

    // Stage 4: Full rescan confirmed the winning hand while auto-win is enabled yet no settlement occurred.
    // Enter silent idle mode for the remainder of this round until settlement / round change / match end.
    this.idleRoundKey=roundKey;
    this.wait=null;
    await record?.({
      kind:'auto_win_idle_until_next_round',
      winKind:wait.kind,
      winTile:wait.winTile,
      hand:rescannedTiles,
      frame:rescanned.id,
      roundKey,
    });
    return {action:'idle',status:'idle_until_next_round',frame:rescanned.id};
  }
}
