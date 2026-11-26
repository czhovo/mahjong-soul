import {GAME} from './game-rules.mjs';
import {roundIdentity} from './round-boundary.mjs';
import {depositsConsistent} from './riichi-deposits.mjs';
import {confirmedNorthStock} from './kita-evidence.mjs';
import {northDraws} from './auto-kita-effect.mjs';
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
 if(Object.values(counts).some(n=>n<0||n>4))return fail('invalid_kita_count_change');
 if(!before.hand?.complete||!after.hand?.complete)return fail('hand_incomplete_during_kita');
 const old=before.hand.tiles.map(t=>t.tile).sort(),hand=after.hand.tiles.map(t=>t.tile);
 const ownNorth=counts.self,chain=ownNorth?northDraws(old,after,ownNorth,{allowUnordered:true}):null;
 const ownOnlyNoOpponents=ownNorth>0&&GAME.opponents.every(p=>!counts[p]);
 if(ownNorth&&(!chain||chain.length!==ownNorth+1||!equal(old,[...(session.ledger?.hand??[])].sort())))return fail('own_kita_draws_not_verified');
 const ownDraw=chain?.at(-1)??(hand.length===old.length+1&&equal(hand.slice(0,-1).sort(),old)?hand.at(-1):null);
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
 const pureOwnChain=ownOnlyNoOpponents&&!Object.keys(discards).length&&confirmedNorthStock(after.kita?.self);
 if(ownNorth&&!pureOwnChain&&(before.round.remaining?.estimated||after.round.remaining?.estimated))return fail('own_kita_wall_not_observed');
 const last=session.requests?.findLast(r=>r.state)?.state?.match(/^3 (\d+) (DRAW|PLAY|LIZHI|KITA)\b/);
 if(!last)return fail('kita_initial_draw_not_committed');
 const alreadyDrawn=last[2]==='DRAW',beginsWithReplacement=last[2]==='KITA';
 let actor=(Number(last[1])+(alreadyDrawn||beginsWithReplacement?0:1))%GAME.players;
 const wall=before.round.remaining?.value,now=after.round.remaining?.value;
 if(!pureOwnChain&&(!Number.isInteger(wall)||!Number.isInteger(now)))return fail('kita_unaccounted_draws');
 const budget=Number.isInteger(wall)&&Number.isInteger(now)?wall-now:null;
 const requests=[],riichi=[];let draws=0;
 const chainOrderCertain=!chain||new Set(chain.slice(0,-1)).size<=1;
 const event=(state,extra={})=>requests.push({state,validact:null,...extra});
 for(let step=0;step<GAME.players;step++,actor=(actor+1)%GAME.players){
  const p=GAME.positions.find(q=>id.seats[q]===actor);
  if(p==='self'){
   if(chain){
    const meta=chainOrderCertain?{}:{historyOrderCertain:false};
    for(const draw of chain.slice(0,-1)){event('2 '+draw,meta);event(`3 ${actor} KITA Z4`,meta);draws++;}
    counts.self=0;
   }
   if(ownDraw){if(![undefined,null,'self'].includes(after.round.turn?.position))return fail('own_draw_actor_mismatch');event(`2 ${ownDraw}`);draws++;}
   break;
  }
  if(!counts[p]&&!discards[p])break;
  if(step||!alreadyDrawn){event(`3 ${actor} DRAW`);draws++;}
  while(counts[p]>0){
   event(`3 ${actor} KITA Z4`);counts[p]--;
   if(counts[p]||discards[p]||(budget!==null&&draws<budget)){event(`3 ${actor} DRAW`);draws++;}
  }
  const tile=discards[p];if(!tile)break;
  event(`3 ${actor} ${tile.sideways?'LIZHI':'PLAY'} ${tile.tile}`);
  if(tile.sideways)riichi.push({seat:actor,eventId:`${after.id}:${actor}:riichi`,confirmed:true});
  delete discards[p];
 }
 // When only self extracted consecutive norths with verified stock & hand multiset,
 // tolerate transient wall OCR lag/estimate (draws>=budget>=1 or budget===null) instead of
 // dropping all KITA events into generic hand reconciliation.
 const wallMatched=budget!==null&&draws===budget;
 const pureOwnWallTolerated=pureOwnChain&&(budget===null||(budget>=1&&budget<=draws));
 if((!wallMatched&&!pureOwnWallTolerated)||Object.values(counts).some(Boolean)||Object.keys(discards).length||ownDraw&&!requests.some(e=>e.state.startsWith('2 ')))return fail('kita_unaccounted_draws');
 let pendingRiichi=null;
 if(riichi.length&&after.controls?.PASS&&requests.at(-1)?.state.includes(' LIZHI ')&&after.round.counters.riichi_sticks-before.round.counters.riichi_sticks===riichi.length-1)pendingRiichi=riichi.pop();
 if(!depositsConsistent(before,after,riichi.length+Number(!!pendingRiichi)))return fail('kita_deposits_mismatch');
 return {verified:true,requests,acceptedRiichi:riichi,pendingRiichi};
}
