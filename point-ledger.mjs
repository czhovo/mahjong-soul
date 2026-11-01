// Scores come from a confirmed opening/settlement checkpoint. During a hand,
// only a confirmed accepted riichi changes them. A declaration click is not proof.
export class PointLedger {
  constructor(scores,riichiSticks=0,source='confirmed-opening') {
    this.check(scores,riichiSticks);
    this.scores=[...scores];this.riichiSticks=riichiSticks;this.source=source;
    this.openingScores=[...scores];this.openingSticks=riichiSticks;
    this.bank=scores.reduce((a,b)=>a+b,0)+1000*riichiSticks;
    this.events=new Map();this.settlements=new Map();
    this.handRiichiCount=0;
  }
  check(scores,sticks){
    if(!Array.isArray(scores)||scores.length!==4||scores.some(x=>!Number.isInteger(x)||x%100!==0)||!Number.isInteger(sticks)||sticks<0)
      throw Error('Four exact scores and a nonnegative stick count required');
  }
  acceptRiichi({eventId,seat,confirmed}){
    if(!confirmed||!eventId||!Number.isInteger(seat)||seat<0||seat>3)throw Error('Confirmed accepted riichi event required');
    if(this.events.has(eventId)){
      if(this.events.get(eventId)!==seat)throw Error('Conflicting repeated riichi event');
      return;
    }
    if(this.scores[seat]<1000)throw Error('Insufficient points for accepted riichi');
    this.scores[seat]-=1000;this.riichiSticks++;this.events.set(eventId,seat);
    this.handRiichiCount++;
  }
  settle({settlementId,scores,riichiSticks,confirmed}){
    if(!confirmed||!settlementId)throw Error('Confirmed settlement page required');
    this.check(scores,riichiSticks);
    if(scores.reduce((a,b)=>a+b,0)+1000*riichiSticks!==this.bank)throw Error('Settlement point conservation failed');
    const signature=JSON.stringify({scores,riichiSticks});
    if(this.settlements.has(settlementId)){
      if(this.settlements.get(settlementId)!==signature)throw Error('Conflicting settlement');
      return;
    }
    this.scores=[...scores];this.riichiSticks=riichiSticks;
    this.openingScores=[...scores];this.openingSticks=riichiSticks;
    this.handRiichiCount=0;
    this.source=`settlement:${settlementId}`;this.settlements.set(settlementId,signature);
  }
  snapshot(observationId){
    if(!observationId)throw Error('Observation binding required');
    return {verified:true,observationId,scores:[...this.scores],riichi_sticks:this.riichiSticks,
      source:this.source,accepted_riichi_events:this.events.size};
  }
  botSnapshot(observationId){
    // Frozen v62 PositionValue subtracts each requests-history riichi itself.
    // Its context is the hand-opening checkpoint, not current live balances.
    return {...this.snapshot(observationId),scores:[...this.openingScores],
      riichi_sticks:this.openingSticks,point_basis:'hand-opening'};
  }
  rebaseSeats(oldToNew){
    if(!Array.isArray(oldToNew)||[...oldToNew].sort().join(',')!=='0,1,2,3')throw Error('Seat permutation required');
    if(this.handRiichiCount)throw Error('Cannot change seats during an unsettled hand');
    const move=values=>{const next=[];values.forEach((v,i)=>next[oldToNew[i]]=v);return next;};
    this.scores=move(this.scores);this.openingScores=move(this.openingScores);
  }
}
