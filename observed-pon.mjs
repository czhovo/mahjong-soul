import {roundIdentity} from './round-boundary.mjs';
// A PASS is an intended input. A verified change to our hand takes precedence.
export function observedPon(watch,frame){
 if(!watch||frame.controls?.PASS||!frame.hand?.complete||frame.hand.rejected?.length)return null;
 const {decision,before}=watch,round=roundIdentity(frame);
 if(!round||JSON.stringify(round)!==JSON.stringify(roundIdentity(before)))return null;
 const source=decision.ledger.lastPlayer,called=decision.ledger.lastDiscard;
 const old=decision.visibleHand,now=frame.hand.tiles.map(t=>t.tile);
 if(now.length!==old.length-2)return null;
 const removed=[...old];for(const t of now){const i=removed.indexOf(t);if(i<0)return null;removed.splice(i,1);}
 const norm=t=>t.replace(/0$/,'5');
 if(!called||source===round.seats.self||!removed.every(t=>norm(t)===norm(called)))return null;
 const pos=Object.keys(round.seats).find(k=>round.seats[k]===source);
 const a=before.own_melds?.groups,b=frame.own_melds?.groups;
 const exact=frame.own_melds?.complete&&a&&b?.length===a.length+1&&b.some(g=>g.kind==='PENG'&&g.fromSeat===source&&g.tiles[g.calledIndex]===called&&!g.estimated&&!g.tracking&&
  [...g.tiles].sort().join() === [called,...removed].sort().join());
 const r=before.rivers?.[pos],s=frame.rivers?.[pos];
 const river=r?.complete&&s?.complete&&r.tiles.at(-1)?.tile===called&&r.tiles.length===s.tiles.length+1&&s.tiles.every((v,i)=>v.tile===r.tiles[i].tile);
 const wall=before.round.remaining?.value;
 if(!exact&&!(river&&Number.isInteger(wall)&&wall===frame.round.remaining?.value))return null;
 return {state:`3 ${round.seats.self} PENG ${[called,...removed].join(' ')}`,validact:'PLAY',observedCallBeforeDiscard:true};
}
