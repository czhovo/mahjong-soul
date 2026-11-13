import {GAME,remainingHands} from './game-rules.mjs';
import {canonicalMelds} from './meld-events.mjs';
import {SpecialSequence} from './special-sequence.mjs';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function verifyKongDraw(decision,before,after,{localOnly=false}={}){
 const [kind,tile]=decision.output.response.split(' ');
 if(!['GANG','ANGANG','BUGANG','KITA'].includes(kind))throw Error('Kong decision required');
 const a=before.round,b=after.round;
 if(!before.hand?.complete||!after.hand?.complete||!a?.seat_identity?.verified||!b?.seat_identity?.verified)throw Error('Incomplete kong observation');
 if(a.wind!==b.wind||a.hand_number.value!==b.hand_number.value||!same(a.counters,b.counters)||!same(a.seat_identity.seats,b.seat_identity.seats))throw Error('Kong round changed');
 if(!localOnly&&(!Number.isInteger(a.remaining.value)||a.remaining.value-b.remaining.value!==1))throw Error('Unaccounted kong draws');
 const lastDiscard={tile:decision.ledger.lastDiscard,seat:decision.ledger.lastPlayer};
 const oldMelds=canonicalMelds(before,'self',before.own_melds),melds=canonicalMelds(after,'self',after.own_melds);
 const sequence=new SpecialSequence(decision.output.response,{verified:true,hand:decision.visibleHand,melds:oldMelds,lastDiscard,kitaCount:before.kita?.self?.count});
 sequence.inputSent();
 const handTiles=after.hand.tiles;
 const turn=after.round.turn?.position;
 const pitches=handTiles.slice(1,-1).map((t,i)=>t.center?.[0]-handTiles[i].center?.[0]).filter(v=>Number.isFinite(v)&&v>0).sort((a,b)=>a-b);
 const priorPitches=before.hand.tiles.slice(1,-1).map((t,i)=>t.center?.[0]-before.hand.tiles[i].center?.[0]).filter(v=>Number.isFinite(v)&&v>0).sort((a,b)=>a-b);
 const pitch=pitches[Math.floor(pitches.length/2)]??priorPitches[Math.floor(priorPitches.length/2)];
 const gap=handTiles.at(-1)?.center?.[0]-handTiles.at(-2)?.center?.[0];
 if((turn!=null&&turn!=='self')||(handTiles.length>1&&(!pitch||!Number.isFinite(gap)||gap<pitch*1.18)))throw Error('Replacement draw lacks independent visible separation');
 const replacementDraw=handTiles.at(-1)?.tile;
 const metadata={verified:true,observationId:after.id,seats:b.seat_identity.seats,melds,hand:after.hand.tiles.map(t=>t.tile),replacementDraw,kitaCount:after.kita?.self?.count,actionCompleted:true};
 // A covered North strip need not hide a verified extraction: exactly one
 // North left the hand, one independent replacement arrived, no river or
 // meld changed, and the wall decreased by exactly one. The sequence below
 // still checks the full hand multiset; failed checks never update the count.
 const stripUnknown=metadata.kitaCount==null||(after.kita?.self?.count_source==='same_round_confirmed_count'&&after.kita.self.observed_count==null);
 const priorNorth=sequence.before.kitaCount;
 const retainedIncrease=kind==='KITA'&&after.kita?.self?.count_source==='same_round_confirmed_count'&&
  !!after.kita.self.sourceFrameId&&after.kita.self.sourceFrameId!==before.id&&
  Number.isInteger(priorNorth)&&metadata.kitaCount===priorNorth+1;
 const kitaByTransition=kind==='KITA'&&(stripUnknown||priorNorth==null)&&
  (stripUnknown||(Number.isInteger(metadata.kitaCount)&&metadata.kitaCount>=1&&metadata.kitaCount<=4))&&
  Number.isInteger(a.remaining.value)&&a.remaining.value-b.remaining.value===1&&
  GAME.positions.every(p=>before.rivers[p]?.complete&&after.rivers[p]?.complete&&
   same(before.rivers[p].tiles.map(t=>t.tile),after.rivers[p].tiles.map(t=>t.tile)));
 // A later occluded strip does not erase a count increase decoded in an
 // intervening frame. Full hand removal/replacement and meld checks below
 // still have to match this exact pending extraction.
 if(stripUnknown&&!retainedIncrease)metadata.kitaCount=null;
 if(kitaByTransition){
  metadata.kitaTransitionVerified=true;
  if(stripUnknown&&Number.isInteger(priorNorth)&&priorNorth>=0&&priorNorth<4)metadata.kitaCount=priorNorth+1;
 }
 sequence.verify(metadata);
 for(const p of localOnly?[]:GAME.positions){
  if(!before.rivers[p]?.complete||!after.rivers[p]?.complete)throw Error('Incomplete kong rivers');
  const expected=before.rivers[p].tiles.map(t=>t.tile);
  if(kind==='GANG'&&a.seat_identity.seats[p]===lastDiscard.seat){if(expected.pop()!==tile)throw Error('Wrong claimed kong tile');}
  if(!same(expected,after.rivers[p].tiles.map(t=>t.tile)))throw Error('Other discard during kong');
 }
 const indicators=after.dora?.tiles?.map(t=>t.tile),old=before.dora?.tiles?.map(t=>t.tile);
 if(!before.dora?.complete||!after.dora?.complete||!indicators?.length||!old?.length||after.dora.rejected?.length||before.dora.rejected?.length||!(kind==='KITA'?[old.length]:[old.length,old.length+1]).includes(indicators.length)||!same(indicators.slice(0,old.length),old))throw Error('Kong indicator not yet verified');
 if(kitaByTransition&&stripUnknown&&metadata.kitaCount!=null)after.kita.self={...after.kita.self,count:metadata.kitaCount,count_source:'confirmed_north_hand_transition',beforeId:before.id,afterId:after.id};
 return {metadata,request:{state:'2 '+replacementDraw,validact:'PLAY',doraIndicators:indicators.join(' ')},frame:after};
}
