import {canonicalMelds} from './meld-events.mjs';
import {promptDiscard} from './current-decision.mjs';
import {roundIdentity} from './round-boundary.mjs';

export function samePassPrompt(before,after,request){
 if(sameReactionWindow(before,after))return true;
 if(!before?.id||before.id===after?.id||!request?.state)return false;
 const a=promptDiscard(before),b=promptDiscard(after);
 if(!a||!b||a.position!==b.position||a.slot!==b.slot||a.event.state!==b.event.state)return false;
 const [type,seat,kind,...args]=request.state.split(' ');
 if(type!=='3'||Number(seat)!==a.round.seats[a.position]||!['PLAY','LIZHI','CHI','PENG'].includes(kind)||args.at(-1)!==a.tile)return false;
 const eq=(x,y)=>JSON.stringify(x)===JSON.stringify(y);
 if(!eq(roundIdentity(before),roundIdentity(after))||!eq(before.round.counters,after.round.counters)||
    before.round.remaining?.value!==after.round.remaining?.value||
    !eq(Object.keys(before.controls).sort(),Object.keys(after.controls).sort())||
    !eq(before.hand.tiles.map(t=>t.tile).sort(),after.hand.tiles.map(t=>t.tile).sort()))return false;
 for(const p of ['self','right','opposite','left']){
  const x=before.rivers?.[p],y=after.rivers?.[p];
  if((p===a.position||x?.complete&&y?.complete)&&!eq(x?.tiles.map(t=>[t.tile,t.sideways]),y?.tiles.map(t=>[t.tile,t.sideways])))return false;
  const m=f=>p==='self'?f.own_melds:f.opponent_melds?.[p];
  if(!m(before)?.complete||!m(after)?.complete||!eq(canonicalMelds(before,p,m(before)),canonicalMelds(after,p,m(after))))return false;
 }
 return true;
}
// A retry is permitted only after a fresh, fully observed unchanged reaction
// window. An AHK receipt or button presence alone is never enough.
export function sameReactionWindow(before,after){
 if(!before?.id||before.id===after?.id||!before.controls?.PASS||!after.controls?.PASS)return false;
 const signature=f=>{
  if(!f.hand?.complete||!f.round?.seat_identity?.verified)throw Error('Incomplete reaction');
  const positions=['self','right','opposite','left'];
  const rivers=positions.map(p=>{const r=f.rivers?.[p];if(!r?.complete)throw Error('Incomplete river');return r.tiles.map(t=>[t.tile,!!t.sideways]);});
  const melds=positions.map(p=>{const m=p==='self'?f.own_melds:f.opponent_melds?.[p];if(!m?.complete)throw Error('Incomplete meld');return canonicalMelds(f,p,m);});
  return JSON.stringify({hand:f.hand.tiles.map(t=>t.tile).sort(),rivers,melds,seats:f.round.seat_identity.seats,
   wind:f.round.wind,handNumber:f.round.hand_number?.value,counters:f.round.counters,remaining:f.round.remaining?.value,
   controls:Object.keys(f.controls).sort()});
 };
 try{return signature(before)===signature(after);}catch{return false;}
}
