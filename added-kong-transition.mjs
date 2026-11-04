import {roundIdentity} from './round-boundary.mjs';
import {canonicalMelds} from './meld-events.mjs';
import {fillWall} from './wall-estimate.mjs';
// Commit a visible PENG -> BUGANG independently of estimated older turn order.
export function addedKongTransition(before,after,session){
 const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b),id=roundIdentity(before);
 if(!id||!eq(id,roundIdentity(after))||!before.hand?.complete||!after.hand?.complete||
    !eq(before.hand.tiles.map(t=>t.tile).sort(),after.hand.tiles.map(t=>t.tile).sort()))return null;
 const seats=id.seats,positions=Object.keys(seats),upgrades=[];
 for(const p of positions){
  let old,now;
  try{old=canonicalMelds(before,p,p==='self'?before.own_melds:before.opponent_melds[p]);
      now=canonicalMelds(after,p,p==='self'?after.own_melds:after.opponent_melds[p]);}catch{return null;}
  if(old.length!==now.length)return null;
  const rest=[...now];
  for(const m of old){
   let i=rest.findIndex(n=>eq(n,m));if(i>=0){rest.splice(i,1);continue;}
   const norm=t=>t.replace(/0$/,'5');
   i=rest.findIndex(n=>p!=='self'&&m.kind==='PENG'&&n.kind==='BUGANG'&&n.from===m.from&&n.calledIndex===m.calledIndex&&
    n.tiles.every(t=>norm(t)===norm(m.tiles[0])));
   if(i<0)return null;upgrades.push({position:p,tile:rest.splice(i,1)[0].tiles[0]});
  }
 }
 const pending=/^3 ([0-3]) BUGANG ([WBTZ][0-9])$/.exec(session.requests?.at(-1)?.state??'');
 if(upgrades.length!==1&&!(upgrades.length===0&&pending))return null;
 const fresh=upgrades[0],position=fresh?.position??positions.find(p=>seats[p]===Number(pending[1]));
 if(!position||position==='self')return null;
 const seat=seats[position],tile=fresh?.tile??pending[2],extra=[];
 for(const p of positions){
  const a=before.rivers?.[p],b=after.rivers?.[p];
  if(!a?.complete||!b?.complete||a.tiles.some((t,i)=>t.tile!==b.tiles[i]?.tile||t.sideways!==b.tiles[i]?.sideways))return null;
  const tail=b.tiles.slice(a.tiles.length);
  if((p!==position&&tail.length)||tail.length>1||tail.some(t=>!t.color?.verified||t.tracking||t.sideways!==false))return null;
  extra.push(...tail);
 }
 if(!eq(before.round.counters,after.round.counters))return null;
 const wall=before.round.remaining?.value,next=after.round.remaining?.value;
 if(!Number.isInteger(wall))return null;
 const delta=Number.isInteger(next)?wall-next:null;
 if(delta!==null&&![0,1].includes(delta))return null;
 const requests=fresh?[{state:`3 ${seat} BUGANG ${tile}`,validact:null}]:[];
 if(delta===1||extra.length){
  requests.push({state:`3 ${seat} DRAW`,validact:null});
  if(delta!==1)fillWall(after,wall-1,'verified-added-kong-draw');
 }
 if(extra.length)requests.push({state:`3 ${seat} PLAY ${extra[0].tile}`,validact:null});
 if(!Number.isInteger(after.round.remaining?.value))fillWall(after,wall,'verified-added-kong-boundary');
 return {verified:true,requests};
}
