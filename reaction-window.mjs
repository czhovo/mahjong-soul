import {GAME,remainingHands} from './game-rules.mjs';
import {canonicalMelds} from './meld-events.mjs';
import {promptDiscard} from './current-decision.mjs';
import {roundIdentity} from './round-boundary.mjs';

// PASS is shared by discard reactions and the following player's draw menu.
// A partially read hand can still show a reliable draw-only action.
export function classifyPassWindow(before,after,decision){
 const original=before.controls??{},current=after.controls??{};
 const ownActions=['LIZHI','TSUMO','KITA','ANGANG','BUGANG','KYUSHU'];
 const old=decision.visibleHand,tiles=after.hand?.tiles?.map(t=>t.tile)??[];
 const equal=(a,b)=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
 const fromDiscard=old.length%3===1&&!ownActions.some(k=>original[k]);
 if(fromDiscard&&after.hand?.complete&&!after.hand.rejected?.length&&tiles.length===old.length+1&&equal(tiles.slice(0,-1),old))return 'draw';
 if(fromDiscard&&ownActions.some(k=>current[k]))return 'draw-menu';
 if(!current.PASS)return 'unknown';
 const a=before.round?.remaining?.value,b=after.round?.remaining?.value;
 const oldTurn=before.round?.turn?.position,turn=after.round?.turn?.position;
 if(Number.isInteger(a)&&Number.isInteger(b)&&a!==b||oldTurn&&turn&&oldTurn!==turn||
    after.hand?.complete&&!equal(old,tiles))return 'unknown';
 const actions=Object.keys(current).filter(k=>k!=='PASS');
 if(actions.length)return actions.every(k=>original[k])?'same':'unknown';
 return samePassPrompt(before,after,decision.input?.requests?.at(-1))?'same':'unknown';
}

export function samePassPrompt(before,after,request){
 if(sameReactionWindow(before,after))return true;
 if(!before?.id||before.id===after?.id||!request?.state||!before.controls?.PASS||!after.controls?.PASS||
    !before.hand?.complete||!after.hand?.complete)return false;
 const a=promptDiscard(before);
 let b=promptDiscard(after);
 // Other reaction buttons can disappear or be partially read while PASS is
 // still present. Retain the sourced discard if its exact river slot remains.
 if(a&&!b){
  const river=after.rivers?.[a.position],tail=river?.tiles?.at(-1),turn=after.round?.turn?.position;
  if(river?.complete&&river.tiles.length===a.slot+1&&tail?.tile===a.tile&&tail.sideways===a.sideways&&
     (!turn||turn===a.position)&&tail.color?.verified&&!tail.tracking)b=a;
 }
 if(!a||!b||a.position!==b.position||a.slot!==b.slot||a.event.state!==b.event.state)return false;
 const [type,seat,kind,...args]=request.state.split(' ');
 if(type!=='3'||Number(seat)!==a.round.seats[a.position]||!['PLAY','LIZHI','CHI','PENG'].includes(kind)||args.at(-1)!==a.tile)return false;
 const eq=(x,y)=>JSON.stringify(x)===JSON.stringify(y);
 if(!eq(roundIdentity(before),roundIdentity(after))||!eq(before.round.counters,after.round.counters)||
    before.round.remaining?.value!==after.round.remaining?.value||
    !eq(before.hand.tiles.map(t=>t.tile).sort(),after.hand.tiles.map(t=>t.tile).sort()))return false;
 for(const p of GAME.positions){
  const x=before.rivers?.[p],y=after.rivers?.[p];
  if((p===a.position||x?.complete&&y?.complete)&&!eq(x?.tiles.map(t=>[t.tile,t.sideways]),y?.tiles.map(t=>[t.tile,t.sideways])))return false;
  const m=f=>p==='self'?f.own_melds:f.opponent_melds?.[p];
  if(p==='self'&&(!m(before)?.complete||!m(after)?.complete))return false;
  if(m(before)?.complete&&m(after)?.complete&&!eq(canonicalMelds(before,p,m(before)),canonicalMelds(after,p,m(after))))return false;
 }
 return true;
}
// A retry is permitted only after a fresh, fully observed unchanged reaction
// window. An AHK receipt or button presence alone is never enough.
export function sameReactionWindow(before,after){
 if(!before?.id||before.id===after?.id||!before.controls?.PASS||!after.controls?.PASS)return false;
 const signature=f=>{
  if(!f.hand?.complete||!f.round?.seat_identity?.verified)throw Error('Incomplete reaction');
  const positions=GAME.positions;
  const rivers=positions.map(p=>{const r=f.rivers?.[p];if(!r?.complete)throw Error('Incomplete river');return r.tiles.map(t=>[t.tile,!!t.sideways]);});
  const melds=positions.map(p=>{const m=p==='self'?f.own_melds:f.opponent_melds?.[p];if(!m?.complete)throw Error('Incomplete meld');return canonicalMelds(f,p,m);});
  return JSON.stringify({hand:f.hand.tiles.map(t=>t.tile).sort(),rivers,melds,seats:f.round.seat_identity.seats,
   wind:f.round.wind,handNumber:f.round.hand_number?.value,counters:f.round.counters,remaining:f.round.remaining?.value,
   controls:Object.keys(f.controls).sort()});
 };
 try{return signature(before)===signature(after);}catch{return false;}
}
