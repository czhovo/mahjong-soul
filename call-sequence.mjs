import {validateMeld,expectedConcealed} from './meld-state.mjs';
const same=(a,b)=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
const norm=t=>t.endsWith('0')?t[0]+'5':t;
function remove(hand,tiles){const r=[...hand];for(const tile of tiles){const i=r.indexOf(tile);if(i<0)throw Error('Call tile absent from hand');r.splice(i,1);}return r;}

// CHI/PENG contain an eventual discard in the bot protocol. The real UI needs
// separate verified steps, and sometimes a combination-choice prompt between.
export class CallSequence {
  constructor(response,before,source) {
    const [kind,called,a,b,discard,...extra]=response.trim().split(/\s+/);
    if(!['CHI','PENG'].includes(kind)||extra.length||(!discard&&!before.allowDeferredDiscard))throw Error('Expected complete CHI/PENG response');
    if(!before.verified||before.hand.length!==expectedConcealed(before.melds,'waiting'))throw Error('Unverified pre-call state');
    this.meld=validateMeld({kind,tiles:[called,a,b],from:source,calledIndex:0});
    this.afterCall=remove(before.hand,[a,b]);
    if(discard&&!this.afterCall.includes(discard))throw Error('Post-call discard missing');
    if(discard&&norm(discard)===norm(called))throw Error('Immediate same-tile exchange is illegal');
    // Exact alternative-sequence kuikae restrictions must also come from the
    // legal discard set observed in the client, not guessed here.
    this.before=structuredClone(before);this.discard=discard;
    this.consumed=[a,b];this.phase='call';
  }
  target(observation) {
    if(!observation.verified||!observation.screenshotId)throw Error('Fresh verified UI state required');
    if(this.phase==='done')throw Error('Call already completed');
    if(this.phase==='await_discard')throw Error('Await discard confirmation; do not repeat input');
    if(this.phase==='await_choice_effect')throw Error('Await combination effect; do not repeat input');
    if(this.phase==='call') {
      if(!same(observation.hand,this.before.hand))throw Error('Hand changed before call');
      const target=observation.controls?.[this.meld.kind];
      if(!target)throw Error('Call button absent');
      return {...target,screenshotId:observation.screenshotId};
    }
    if(this.phase==='await_meld') {
      const choices=observation.choices?.filter(c=>same(c.consumed,this.consumed))??[];
      if(choices.length!==1)throw Error('Await verified meld or unambiguous combination');
      return {...choices[0].target,screenshotId:observation.screenshotId};
    }
    if(!same(observation.hand,this.afterCall)||!observation.legalDiscards?.includes(this.discard))throw Error('Discard not verified as legal after call');
    const target=observation.handLocations?.find(p=>p.tile===this.discard);
    if(!target)throw Error('Discard tile location absent');
    return {...target,screenshotId:observation.screenshotId};
  }
  inputSent() {if(this.phase==='call')this.phase='await_meld';else if(this.phase==='await_meld')this.phase='await_choice_effect';else if(this.phase==='discard')this.phase='await_discard';}
  verifyMeld(observation) {
    if(!['await_meld','await_choice_effect'].includes(this.phase)||!observation.verified||!same(observation.hand,this.afterCall))throw Error('Meld transition not confirmed');
    if(observation.melds.length!==this.before.melds.length+1)throw Error('Wrong meld count');
    const remaining=observation.melds.map(validateMeld);
    for(const old of this.before.melds){const i=remaining.findIndex(m=>m.kind===old.kind&&m.from===old.from&&m.tiles[m.calledIndex]===old.tiles[old.calledIndex]&&same(m.tiles,old.tiles));if(i<0)throw Error('Existing meld changed');remaining.splice(i,1);}
    const added=remaining[0];
    if(added.kind!==this.meld.kind||added.from!==this.meld.from||!same(added.tiles,this.meld.tiles))throw Error('Wrong new meld');
    this.phase='discard';
  }
  verifyDiscard(observation) {
    const hand=observation.drawAfterDiscard?remove(observation.hand,[observation.drawAfterDiscard]):observation.hand;
    if(this.phase!=='await_discard'||!observation.verified||observation.lastOwnDiscard!==this.discard||!same(hand,remove(this.afterCall,[this.discard])))throw Error('Discard not confirmed');
    this.phase='done';
  }
}
