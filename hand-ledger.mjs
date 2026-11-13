const normal=t=>t?.endsWith('0')?t[0]+'5':t;
export function initialLedger(seat,hand){return {seat,hand:[...hand],lastDiscard:null,lastPlayer:null};}
export function applyPublicEvent(previous,event){
  const state=structuredClone(previous);
  if(event.handTiles){state.hand=event.handTiles.trim().split(/\s+/).slice(1);return state;}
  const remove=tile=>{const i=state.hand.indexOf(tile);if(i<0)throw Error(`Public event removes absent tile ${tile}`);state.hand.splice(i,1);};
  const words=event.state?.split(/\s+/)??[];
  if(words[0]==='2'){state.hand.push(words[1]);return state;}
  if(words[0]!=='3')return state;
  const actor=Number(words[1]),kind=words[2],own=actor===state.seat;
  if(kind==='PLAY'||kind==='LIZHI'){
    if(own)remove(words[3]);state.lastDiscard=words[3];state.lastPlayer=actor;
  }else if(kind==='CHI'||kind==='PENG'){
    const tiles=words.slice(3,6),called=tiles.indexOf(state.lastDiscard);
    const pendingDiscard=own&&kind==='PENG'&&words.length===6&&event.observedCallBeforeDiscard===true;
    if(called<0||(!pendingDiscard&&words.length!==7))throw Error('Call does not match preceding discard');
    if(own){tiles.splice(called,1);tiles.forEach(remove);if(pendingDiscard)return state;remove(words[6]);}
    state.lastDiscard=words[6];state.lastPlayer=actor;
  }else if(own&&['GANG','ANGANG'].includes(kind)){
    const tile=words[3]??state.lastDiscard;
    const count=kind==='ANGANG'?4:3;
    const tiles=state.hand.filter(t=>normal(t)===normal(tile));
    if(tiles.length!==count)throw Error('Kong tile count mismatch');
    tiles.forEach(remove);
  }else if(own&&kind==='BUGANG'){remove(words[3]);}
  else if(kind==='KITA'){if(words[3]!=='Z4')throw Error('KITA requires north');if(own)remove('Z4');}
  return state;
}
export function assertVisibleHand(ledger,visible){
  if(JSON.stringify([...ledger.hand].sort())!==JSON.stringify([...visible].sort()))throw Object.assign(Error('Observed hand differs from public event history'),{code:'VISIBLE_HAND_CONFLICT'});
}
