import {GAME} from './game-rules.mjs';
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
   if(Number.isInteger(visible.count)&&visible.count>=0&&visible.count<=4&&
      (!prior||visible.count>=prior.count))this.counts[p]={count:visible.count,id:frame.id};
   else if(prior)frame.kita[p]={...visible,observed_count:visible.count,count:prior.count,count_source:'same_round_confirmed_count',sourceFrameId:prior.id};
  }
 }
}
