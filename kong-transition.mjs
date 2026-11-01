import {canonicalMelds} from './meld-events.mjs';
import {SpecialSequence} from './special-sequence.mjs';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function verifyKongDraw(decision,before,after,{localOnly=false}={}){
 const [kind,tile]=decision.output.response.split(' ');
 if(!['GANG','ANGANG','BUGANG'].includes(kind))throw Error('Kong decision required');
 const a=before.round,b=after.round;
 if(!before.hand?.complete||!after.hand?.complete||!a?.seat_identity?.verified||!b?.seat_identity?.verified)throw Error('Incomplete kong observation');
 if(a.wind!==b.wind||a.hand_number.value!==b.hand_number.value||!same(a.counters,b.counters)||!same(a.seat_identity.seats,b.seat_identity.seats))throw Error('Kong round changed');
 if(!localOnly&&(!Number.isInteger(a.remaining.value)||a.remaining.value-b.remaining.value!==1))throw Error('Unaccounted kong draws');
 const lastDiscard={tile:decision.ledger.lastDiscard,seat:decision.ledger.lastPlayer};
 const oldMelds=canonicalMelds(before,'self',before.own_melds),melds=canonicalMelds(after,'self',after.own_melds);
 const sequence=new SpecialSequence(decision.output.response,{verified:true,hand:decision.visibleHand,melds:oldMelds,lastDiscard});
 sequence.inputSent();
 const handTiles=after.hand.tiles;
 const turn=after.round.turn?.position;
 const pitches=handTiles.slice(1,-1).map((t,i)=>t.center?.[0]-handTiles[i].center?.[0]).filter(v=>Number.isFinite(v)&&v>0).sort((a,b)=>a-b);
 const priorPitches=before.hand.tiles.slice(1,-1).map((t,i)=>t.center?.[0]-before.hand.tiles[i].center?.[0]).filter(v=>Number.isFinite(v)&&v>0).sort((a,b)=>a-b);
 const pitch=pitches[Math.floor(pitches.length/2)]??priorPitches[Math.floor(priorPitches.length/2)];
 const gap=handTiles.at(-1)?.center?.[0]-handTiles.at(-2)?.center?.[0];
 if((turn!=null&&turn!=='self')||(handTiles.length>1&&(!pitch||!Number.isFinite(gap)||gap<pitch*1.18)))throw Error('Replacement draw lacks independent visible separation');
 const replacementDraw=handTiles.at(-1)?.tile;
 const metadata={verified:true,observationId:after.id,seats:b.seat_identity.seats,melds,hand:after.hand.tiles.map(t=>t.tile),replacementDraw,actionCompleted:true};
 sequence.verify(metadata);
 for(const p of localOnly?[]:['self','right','opposite','left']){
  if(!before.rivers[p]?.complete||!after.rivers[p]?.complete)throw Error('Incomplete kong rivers');
  const expected=before.rivers[p].tiles.map(t=>t.tile);
  if(kind==='GANG'&&a.seat_identity.seats[p]===lastDiscard.seat){if(expected.pop()!==tile)throw Error('Wrong claimed kong tile');}
  if(!same(expected,after.rivers[p].tiles.map(t=>t.tile)))throw Error('Other discard during kong');
 }
 const indicators=after.dora?.tiles?.map(t=>t.tile),old=before.dora?.tiles?.map(t=>t.tile);
 if(!before.dora?.complete||!after.dora?.complete||!indicators?.length||!old?.length||after.dora.rejected?.length||before.dora.rejected?.length||![old.length,old.length+1].includes(indicators.length)||!same(indicators.slice(0,old.length),old))throw Error('Kong indicator not yet verified');
 return {metadata,request:{state:'2 '+replacementDraw,validact:'PLAY',doraIndicators:indicators.join(' ')},frame:after};
}
