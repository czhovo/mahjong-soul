// Canonical public meld state. Vision must supply verified tiles and source;
// sideways geometry alone is insufficient to infer an entire call event.
const tileCode=/^(?:[WBT][0-9]|Z[1-7])$/;
const normal=t=>t.endsWith('0')?t[0]+'5':t;
export function validateMeld(meld) {
  const {kind,tiles,from,calledIndex}=meld;
  if(!['CHI','PENG','GANG','ANGANG','BUGANG'].includes(kind))throw Error('Unknown meld type');
  const count=['CHI','PENG'].includes(kind)?3:4;
  if(!Array.isArray(tiles)||tiles.length!==count||tiles.some(t=>!tileCode.test(t)))throw Error('Incomplete meld tiles');
  const normalized=tiles.map(normal);
  if(kind==='CHI') {
    const ordered=normalized.slice().sort();
    if(ordered[0][0]==='Z'||ordered.some(t=>t[0]!==ordered[0][0])||+ordered[1][1]!==+ordered[0][1]+1||+ordered[2][1]!==+ordered[0][1]+2)throw Error('Invalid sequence');
  } else if(new Set(normalized).size!==1)throw Error('Meld identities disagree');
  if(kind==='ANGANG') {
    if(from!==null||calledIndex!==null)throw Error('Concealed kong has no called tile');
  } else if(!Number.isInteger(from)||from<0||from>3||!Number.isInteger(calledIndex)||calledIndex<0||calledIndex>=count)throw Error('Missing call source');
  return structuredClone(meld);
}
export function expectedConcealed(melds,phase) {
  if(melds.length>4||!['waiting','discard','rinshan_pending'].includes(phase))throw Error('Invalid hand phase');
  melds.forEach(validateMeld);
  return (phase==='discard'?14:13)-3*melds.length;
}
export function upgradePung(melds,index,tile) {
  const pung=melds[index];
  if(!pung||pung.kind!=='PENG'||normal(pung.tiles[0])!==normal(tile))throw Error('Added kong requires matching pung');
  const result=structuredClone(melds);
  result[index]=validateMeld({...pung,kind:'BUGANG',tiles:[...pung.tiles,tile]});
  return result;
}
