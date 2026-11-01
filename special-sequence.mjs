import {validateMeld} from './meld-state.mjs';
import {discardTarget} from './discard-target.mjs';
const same=(a,b)=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
const norm=t=>t.endsWith('0')?t[0]+'5':t;
const remove=(hand,tiles)=>{const result=[...hand];for(const tile of tiles){const i=result.indexOf(tile);if(i<0)throw Error('Action removes an absent tile');result.splice(i,1);}return result;};

export class SpecialSequence {
  constructor(response,before){
    const [kind,tile,...extra]=response.trim().split(/\s+/);
    if(!['LIZHI','GANG','ANGANG','BUGANG','HU'].includes(kind)||extra.length)throw Error('Unsupported special action');
    if(!before.verified)throw Error('Verified input required');
    if(kind!=='HU'&&!/^(?:[WBT][0-9]|Z[1-7])$/.test(tile??''))throw Error('Missing action tile');
    if(kind==='HU'&&tile)throw Error('HU takes no tile argument');
    this.kind=kind;this.tile=tile;this.before=structuredClone(before);this.phase='button';
    if(kind==='LIZHI'||kind==='BUGANG')this.after=remove(before.hand,[tile]);
    if(kind==='GANG'||kind==='ANGANG'){
      const consumed=before.hand.filter(t=>norm(t)===norm(tile));
      if(consumed.length!==(kind==='GANG'?3:4))throw Error('Incorrect kong tile count');
      this.after=remove(before.hand,consumed);this.consumed=consumed;
    }
    if(kind==='BUGANG'&&!before.melds.some(m=>m.kind==='PENG'&&m.tiles.every(t=>norm(t)===norm(tile))))throw Error('Added kong has no existing pung');
    if(kind==='GANG'){
      if(before.lastDiscard?.tile!==tile||!Number.isInteger(before.lastDiscard?.seat))throw Error('Open kong requires the observed discard and source');
    }
  }
  target(observation){
    if(!observation.verified||!observation.screenshotId)throw Error('Verified observation required');
    if(this.phase==='button'){
      if(!same(observation.hand,this.before.hand))throw Error('Hand changed before action');
      const button=observation.controls?.[this.kind]??(['GANG','ANGANG','BUGANG'].includes(this.kind)?observation.controls?.GANG:null);
      if(!button)throw Error('Required action button absent');return button;
    }
    if(this.phase==='selection'&&this.kind==='LIZHI'){
      if(!same(observation.hand,this.before.hand)||!observation.legalDiscards?.includes(this.tile))throw Error('Riichi discard selection is not verified');
      const target=discardTarget(observation.handLocations,this.tile);
      if(!target)throw Error('Riichi discard absent');return target;
    }
    if(this.phase==='selection'){
      const choices=observation.choices?.filter(c=>c.kind===this.kind&&norm(c.tile)===norm(this.tile))??[];
      if(choices.length!==1)throw Error('Await unambiguous kong selection or confirmation');return choices[0].target;
    }
    throw Error('Await action confirmation; do not repeat input');
  }
  inputSent(){this.phase=this.phase==='button'?(this.kind==='HU'?'confirmation':'selection'):'confirmation';}
  verify(observation){
    if(!['selection','confirmation'].includes(this.phase)||!observation.verified)throw Error('No pending action to verify');
    if(this.kind==='LIZHI'){
      const hand=observation.drawAfterDiscard?remove(observation.hand,[observation.drawAfterDiscard]):observation.hand;
      if(this.phase!=='confirmation'||observation.lastOwnDiscard!==this.tile||!observation.ownRiichi||!same(hand,this.after))throw Error('Riichi not confirmed');
    }else if(this.kind==='HU'){
      if(observation.confirmedOwnAction!=='HU')throw Error('Win action not confirmed');
    }else{
      const hand=observation.replacementDraw?remove(observation.hand,[observation.replacementDraw]):observation.hand;
      if(!same(hand,this.after))throw Error('Kong hand transition not confirmed');
      const old=this.before.melds.map(validateMeld),current=observation.melds.map(validateMeld);
      let expectedTiles=this.consumed,expectedFrom=null,expectedCalledIndex=null;
      if(this.kind==='BUGANG'){
        const index=old.findIndex(m=>m.kind==='PENG'&&norm(m.tiles[0])===norm(this.tile));
        expectedTiles=[...old[index].tiles,this.tile];expectedFrom=old[index].from;expectedCalledIndex=old[index].calledIndex;
        old.splice(index,1);
      }
      if(this.kind==='GANG'){expectedTiles=[...this.consumed,this.tile];expectedFrom=this.before.lastDiscard.seat;}
      for(const meld of old){const index=current.findIndex(m=>m.kind===meld.kind&&m.from===meld.from&&m.calledIndex===meld.calledIndex&&same(m.tiles,meld.tiles));if(index<0)throw Error('Existing meld changed');current.splice(index,1);}
      if(current.length!==1||current[0].kind!==this.kind||current[0].tiles.some(t=>norm(t)!==norm(this.tile)))throw Error('Wrong kong meld');
      if(!same(current[0].tiles,expectedTiles)||current[0].from!==expectedFrom)throw Error('Kong identity or source changed');
      if(this.kind==='BUGANG'&&current[0].calledIndex!==expectedCalledIndex)throw Error('Added kong changed called tile');
    }
    this.phase='done';return true;
  }
}
