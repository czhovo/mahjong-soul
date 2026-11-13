import {GAME} from './game-rules.mjs';
import {roundIdentity} from './round-boundary.mjs';
import {depositsConsistent} from './riichi-deposits.mjs';
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=reason=>({verified:false,reason,requests:[]});
// The visible extraction stock can only grow within a hand. Decode the ordered
// prefix from the previous draw/discard; the wall accounts for every DRAW,
// including each replacement. Never put an extracted North into a river.
export function kitaTransition(before,after,session){
 if(!GAME.sanma)return null;
 const counts={},discards={};
 for(const p of GAME.positions){
  const a=before.kita?.[p]?.count,b=after.kita?.[p]?.count;
  counts[p]=Number.isInteger(a)&&Number.isInteger(b)?b-a:0;
 }
 if(!Object.values(counts).some(Boolean))return null;
 const id=roundIdentity(after);
 if(!id||!equal(roundIdentity(before),id))return fail('kita_transition_incomplete');
 if(counts.self)return fail('own_kita_requires_pending_confirmation');
 if(Object.values(counts).some(n=>n<0||n>4))return fail('invalid_kita_count_change');
 if(!before.hand?.complete||!after.hand?.complete)return fail('hand_incomplete_during_kita');
 const old=before.hand.tiles.map(t=>t.tile).sort(),hand=after.hand.tiles.map(t=>t.tile);
 const ownDraw=hand.length===old.length+1&&equal(hand.slice(0,-1).sort(),old)?hand.at(-1):null;
 if(!ownDraw&&!equal([...hand].sort(),old))return fail('hand_changed_during_kita');
 for(const p of GAME.positions){
  const a=before.rivers?.[p],b=after.rivers?.[p];
  if(!a?.complete||!b?.complete)return fail('kita_river_incomplete');
  const pair=t=>[t.tile,t.sideways];
  if(!equal(a.tiles.map(pair),b.tiles.slice(0,a.tiles.length).map(pair)))return fail('river_changed_during_kita');
  const added=b.tiles.slice(a.tiles.length);
  if(added.length){
   const t=added[0];
   if(p==='self'||added.length!==1||!t.color?.verified||t.tracking||typeof t.sideways!=='boolean')return fail('discard_during_kita');
   discards[p]=t;
  }
  const am=p==='self'?before.own_melds:before.opponent_melds?.[p],bm=p==='self'?after.own_melds:after.opponent_melds?.[p];
  if(!am?.complete||!bm?.complete||!equal(am.groups,bm.groups))return fail('meld_changed_during_kita');
 }
 const last=session.requests?.findLast(r=>r.state)?.state?.match(/^3 (\d+) (DRAW|PLAY|LIZHI|KITA)\b/);
 if(!last)return fail('kita_initial_draw_not_committed');
 const alreadyDrawn=last[2]==='DRAW',beginsWithReplacement=last[2]==='KITA';
 let actor=(Number(last[1])+(alreadyDrawn||beginsWithReplacement?0:1))%GAME.players;
 const wall=before.round.remaining?.value,now=after.round.remaining?.value;
 if(!Number.isInteger(wall)||!Number.isInteger(now))return fail('kita_unaccounted_draws');
 const budget=wall-now,requests=[],riichi=[];let draws=0;
 const event=state=>requests.push({state,validact:null});
 for(let step=0;step<GAME.players;step++,actor=(actor+1)%GAME.players){
  const p=GAME.positions.find(q=>id.seats[q]===actor);
  if(p==='self'){
   if(ownDraw){if(![undefined,null,'self'].includes(after.round.turn?.position))return fail('own_draw_actor_mismatch');event(`2 ${ownDraw}`);draws++;}
   break;
  }
  if(!counts[p]&&!discards[p])break;
  if(step||!alreadyDrawn){event(`3 ${actor} DRAW`);draws++;}
  while(counts[p]>0){
   event(`3 ${actor} KITA Z4`);counts[p]--;
   if(counts[p]||discards[p]||draws<budget){event(`3 ${actor} DRAW`);draws++;}
  }
  const tile=discards[p];if(!tile)break;
  event(`3 ${actor} ${tile.sideways?'LIZHI':'PLAY'} ${tile.tile}`);
  if(tile.sideways)riichi.push({seat:actor,eventId:`${after.id}:${actor}:riichi`,confirmed:true});
  delete discards[p];
 }
 if(draws!==budget||Object.values(counts).some(Boolean)||Object.keys(discards).length||ownDraw&&!requests.some(e=>e.state.startsWith('2 ')))return fail('kita_unaccounted_draws');
 let pendingRiichi=null;
 if(riichi.length&&after.controls?.PASS&&requests.at(-1)?.state.includes(' LIZHI ')&&after.round.counters.riichi_sticks-before.round.counters.riichi_sticks===riichi.length-1)pendingRiichi=riichi.pop();
 if(!depositsConsistent(before,after,riichi.length+Number(!!pendingRiichi)))return fail('kita_deposits_mismatch');
 return {verified:true,requests,acceptedRiichi:riichi,pendingRiichi};
}
