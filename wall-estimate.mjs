// Physical tile accounting: 52 initial concealed tiles; exposed kongs add
// one tile each. Called discards are already absent from the visible rivers.
export function estimateWall(frame){
 const ps=['self','right','opposite','left'];
 if(!frame.hand?.complete||ps.some(p=>!frame.rivers?.[p]?.complete))return null;
 const melds=ps.map(p=>p==='self'?frame.own_melds:frame.opponent_melds?.[p]);
 if(melds.some(m=>!m?.complete))return null;
 const kongs=melds.flatMap(m=>m.groups).filter(m=>['GANG','ANGANG','BUGANG'].includes(m.kind)).length;
 const rivers=ps.reduce((n,p)=>n+frame.rivers[p].tiles.length,0);
 const ownExtra=frame.hand.tiles.length===14-3*frame.own_melds.groups.length;
 const extra=ownExtra||(!frame.controls?.PASS&&frame.round?.turn?.position!=null)?1:0;
 return Math.max(0,Math.min(69,70-rivers-kongs-extra));
}
export function fillWall(frame,value,source){
 frame.round.remaining={...frame.round.remaining,observedValue:frame.round.remaining?.observedValue??frame.round.remaining?.value,value,estimated:true,source};
}
