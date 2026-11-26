import {GAME} from './game-rules.mjs';
function allNorthsVisible(strip){
 return Number.isInteger(strip?.count)&&strip.count>0&&strip.count<=4&&
  strip.tiles?.filter(t=>t.tile==='Z4'&&!t.tracking&&t.color?.verified).length===strip.count;
}
export function confirmedNorthStock(strip){
 return allNorthsVisible(strip)||(!!strip?.verifiedNorthFrameId&&
  Number.isInteger(strip.count)&&strip.count>0&&strip.count<=4&&
  (strip.count_source!=='same_round_confirmed_count'||strip.observed_count==null));
}
function roundKey(f){
 const r=f.round;
 if(!r?.seat_identity?.verified||![r.wind,r.hand_number?.value,r.counters?.honba].every(Number.isInteger))return null;
 return JSON.stringify([r.wind,r.hand_number.value,r.counters.honba,r.seat_identity.seats]);
}
export class KitaEvidence {
 observe(frame){
  const key=roundKey(frame);if(!key)return;
  if(key!==this.key){this.key=key;this.counts={};}
  for(const p of GAME.positions){
   const visible=frame.kita?.[p],prior=this.counts[p];
   if(!visible)continue;
   if(visible.count_source==='same_round_confirmed_count')continue;
   if(Number.isInteger(visible.count)&&visible.count>=0&&visible.count<=4&&
      (!prior||visible.count>=prior.count)){
    const allVisible=allNorthsVisible(visible);
    const handConfirmed=visible.count_source==='confirmed_north_hand_transition';
    // Never let an unverified higher count (e.g., transient animation/ghost tile)
    // permanently ratchet the cached north count upward and poison later frames.
    if(visible.count>(prior?.count??0)&&!allVisible&&!handConfirmed)continue;
    const verifiedNorthFrameId=allVisible?frame.id:
     prior?.count===visible.count?prior.verifiedNorthFrameId:undefined;
    this.counts[p]={count:visible.count,id:frame.id,verifiedNorthFrameId};
    if(verifiedNorthFrameId&&!allVisible)
     visible.verifiedNorthFrameId=verifiedNorthFrameId;
   }else if(prior)frame.kita[p]={...visible,observed_count:visible.count,count:prior.count,count_source:'same_round_confirmed_count',sourceFrameId:prior.id,verifiedNorthFrameId:prior.verifiedNorthFrameId};
  }
 }
}
