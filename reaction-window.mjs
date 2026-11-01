import {canonicalMelds} from './meld-events.mjs';
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
