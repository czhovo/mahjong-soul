import {canonicalMelds} from './meld-events.mjs';
import {roundIdentity} from './round-boundary.mjs';
const same=(a,b)=>[...a].sort().join(' ')===[...b].sort().join(' ');
export function actualCall(decision,before,frame){
 if(!frame.hand?.complete||!frame.own_melds?.complete||frame.call_choices?.verified)return null;
 const a=roundIdentity(before),b=roundIdentity(frame);if(!a||!b||JSON.stringify(a)!==JSON.stringify(b))return null;
 const [kind,called]=decision.output.response.split(' '),source=decision.ledger.lastPlayer;
 if(!['CHI','PENG'].includes(kind)||decision.ledger.lastDiscard!==called)return null;
 const old=canonicalMelds(before,'self',before.own_melds),rest=canonicalMelds(frame,'self',frame.own_melds);
 if(rest.length!==old.length+1)return null;
 for(const m of old){const i=rest.findIndex(n=>m.kind===n.kind&&m.from===n.from&&m.tiles[m.calledIndex]===n.tiles[n.calledIndex]&&same(m.tiles,n.tiles));if(i<0)return null;rest.splice(i,1);}
 const m=rest[0];if(!['CHI','PENG'].includes(m.kind)||m.from!==source||m.tiles[m.calledIndex]!==called)return null;
 const supplied=m.tiles.filter((_,i)=>i!==m.calledIndex),hand=[...decision.visibleHand];
 for(const t of supplied){const i=hand.indexOf(t);if(i<0)return null;hand.splice(i,1);}
 if(!same(hand,frame.hand.tiles.map(t=>t.tile)))return null;
 // An inferred or retained new group cannot establish a different action.
 if(frame.own_melds.groups.some(g=>g.estimated||g.tracking))return null;
 return {response:[m.kind,called,...supplied].join(' '),hand_tiles:frame.hand.tiles.map(t=>t.tile),legal_discards:frame.selection?.legalDiscards??[]};
}
export function sameCall(a,b){const x=a.split(' '),y=b.split(' ');return x[0]===y[0]&&x[1]===y[1]&&same(x.slice(2,4),y.slice(2,4));}
