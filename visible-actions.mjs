import {GAME} from './game-rules.mjs';
// Build only the action types exposed by the current client buttons.
// The frozen bot chooses tiles/chi combinations from its public hand history.
const norm=t=>t.endsWith('0')?t[0]+'5':t;
export function riichiKongTile(frame){
  const c=frame.controls??{},h=frame.hand,m=frame.own_melds;
  if(!(c.GANG||c.ANGANG)||!c.PASS||c.HU||c.TSUMO||!h?.complete||h.rejected?.length||
     !m?.complete||h.tiles.length!==14-3*m.groups.length)return null;
  const draw=norm(h.tiles.at(-1).tile);
  return h.tiles.filter(t=>norm(t.tile)===draw).length===4?draw:null;
}
export function riichiDecisionPrompt(frame){
  if(riichiKongTile(frame))return true;
  const c=frame.controls??{},h=frame.hand,m=frame.own_melds;
  return !!(GAME.sanma&&c.KITA&&c.PASS&&!c.HU&&!c.TSUMO&&h?.complete&&!h.rejected?.length&&
    m?.complete&&h.tiles.length===14-3*m.groups.length&&h.tiles.some(t=>t.tile==='Z4'));
}
export function visibleActions(frame,event,melds){
  if(!frame.hand?.complete)throw Error('Complete visible hand required');
  const controls=frame.controls??{},own=event.state?.startsWith('2 ');
  const actions=[];
  if(own){
    actions.push('PLAY');
    if(controls.TSUMO)actions.push('TSUMO');
    if(controls.LIZHI)actions.push('LIZHI');
    if(GAME.sanma&&controls.KITA&&frame.hand.tiles.some(t=>t.tile==='Z4'))actions.push('KITA Z4');
    if(controls.GANG||controls.ANGANG){
      if(!Array.isArray(melds))throw Error('Verified melds required to distinguish kong types');
      const tiles=frame.hand.tiles.map(t=>t.tile),counts=new Map();
      for(const tile of tiles)counts.set(norm(tile),(counts.get(norm(tile))??0)+1);
      const closed=[...counts].filter(([,n])=>n===4).map(([t])=>t);
      const added=melds.filter(m=>m.kind==='PENG'&&counts.has(norm(m.tiles[0]))).map(m=>norm(m.tiles[0]));
      if(closed.length)actions.push('ANGANG '+closed.join(' '));
      if(added.length)actions.push('BUGANG '+[...new Set(added)].join(' '));
      if(!closed.length&&!added.length)throw Error('Kong button has no accounted-for candidate');
    }
  }else{
    if(!/^3 [0-3] (PLAY|LIZHI|CHI|PENG|BUGANG|KITA) /.test(event.state??''))throw Error('Reaction requires a public discard or added kong');
    if(!controls.PASS)throw Error('Reaction window is not visible');
    actions.push('PASS');
    for(const name of GAME.sanma?['PENG','GANG','RONG']:['CHI','PENG','GANG','RONG'])if(controls[name])actions.push(name);
  }
  return {...event,validact:actions.join(',')};
}
