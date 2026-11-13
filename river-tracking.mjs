import {GAME,remainingHands} from './game-rules.mjs';
import {roundIdentity} from './round-boundary.mjs';
// Preserve identities of already observed immutable river tiles when an overlay
// hides a marker. This is temporal tracking, explicitly not fresh recognition.
export class RiverObservationCache {
 constructor(){this.sources=new Map();this.identity=null;this.callGroups=new Map();this.calledTails=new Map();}
 conflicts(raw){
  const r=raw.round;
  if(!r?.seat_identity?.verified||JSON.stringify([r.wind,r.hand_number?.value,r.counters?.honba,r.seat_identity.seats])!==this.identity)return [];
  return [...this.sources].flatMap(([position,source])=>(raw.rivers?.[position]?.tiles??[]).flatMap(t=>{
   const old=source.rivers[position].tiles.find(v=>v.center&&t.center&&Math.hypot(v.center[0]-t.center[0],v.center[1]-t.center[1])<6);
   return old&&(old.tile!==t.tile||old.sideways!==t.sideways)?[{position,slot:t.row*6+t.column,previous:old.tile,observed:t.tile,previousSideways:old.sideways,observedSideways:t.sideways}]:[];
  }));
 }
 apply(raw){
  const r=raw.round;
  const valid=r&&Number.isInteger(r.wind)&&Number.isInteger(r.hand_number?.value)&&Number.isInteger(r.counters?.honba)&&r.seat_identity?.verified===true;
  const identity=valid?JSON.stringify([r.wind,r.hand_number.value,r.counters.honba,r.seat_identity.seats]):null;
  // An unreadable animation is not evidence of a new round. Keep prior
  // evidence dormant until the same identity is independently visible again.
  if(identity&&identity!==this.identity){this.sources.clear();this.callGroups.clear();this.calledTails.clear();this.identity=identity;}
  if(!identity)return raw;
  const owners=GAME.positions;
  for(const [i,owner] of owners.entries()){
   const band=owner==='self'?raw.own_melds:raw.opponent_melds?.[owner];
   if(!band?.complete||band.tracking||band.groups.some(g=>g.estimated||g.tracking))continue;
   const prior=this.callGroups.get(owner),rest=[...band.groups];
   if(prior){
    const same=(a,b)=>a.kind===b.kind&&a.calledIndex===b.calledIndex&&a.tiles[a.calledIndex]===b.tiles[b.calledIndex]&&a.fromRelative===b.fromRelative&&[...a.tiles].sort().join(' ')===[...b.tiles].sort().join(' ');
    const norm=t=>t?.replace(/0$/,'5');
    if(!prior.every(g=>{const n=rest.findIndex(m=>same(g,m)||(g.kind==='PENG'&&['BUGANG','GANG'].includes(m.kind)&&g.fromRelative===m.fromRelative&&norm(g.tiles[0])===norm(m.tiles[0])));if(n<0)return false;rest.splice(n,1);return true;}))continue;
    for(const g of rest){
     const offset=GAME.relativeOffset[g.fromRelative];
     if(offset===undefined||!Number.isInteger(g.calledIndex)||!['CHI','PENG','GANG'].includes(g.kind))continue;
     const source=owners[(i+offset)%owners.length],tiles=this.sources.get(source)?.rivers[source].tiles;
     if(tiles?.length&&tiles.at(-1).tile===g.tiles[g.calledIndex])this.calledTails.set(source,{slot:tiles.length-1,tile:tiles.at(-1).tile});
    }
   }
   this.callGroups.set(owner,structuredClone(band.groups));
  }
  let result=raw;
  for(const position of GAME.positions){
   let region=result.rivers?.[position];
   const source=this.sources.get(position),old=source?.rivers?.[position];
   const unchangedMelds=source?.meldSignature&&source.meldSignature===meldSignature(raw);
   const claim=this.calledTails.get(position);
   const canRemove=claim&&old&&claim.slot===old.tiles.length-1&&claim.tile===old.tiles.at(-1)?.tile;
   if(old&&region?.complete&&region.tiles.length<old.tiles.length&&!(canRemove&&region.tiles.length===claim.slot&&region.tiles.every((t,i)=>t.tile===old.tiles[i].tile&&!!t.sideways===!!old.tiles[i].sideways))){
    if(result===raw)result=structuredClone(raw);
    region=result.rivers[position];region.complete=false;
    region.tiles=old.tiles.map(t=>({...structuredClone(t),tracking:{source:source.id,reason:'no matching call on last discard'}}));continue;
   }
   if(old&&region&&!canRemove&&(!source.meldSignature||unchangedMelds)){
    // Confirmed old identities are immutable at the same occupied location.
    // Keep a local disagreement rather than replacing the entire history.
    const conflicts=region.tiles.map((t,i)=>({t,i,known:old.tiles.find(v=>v.center&&t.center&&Math.hypot(v.center[0]-t.center[0],v.center[1]-t.center[1])<6)}))
      .filter(({t,known})=>known&&(known.tile!==t.tile||known.sideways!==t.sideways));
    if(conflicts.length){
     if(result===raw)result=structuredClone(raw);
     region=result.rivers[position];
     for(const {i,known} of conflicts)region.tiles[i]={...region.tiles[i],tile:known.tile,sideways:known.sideways,tracking:{source:source.id,reason:'confirmed immutable discard retained over conflicting frame'}};
    }
   }
   if(old?.tiles.length&&region&&!region.complete&&source.meldSignature&&source.meldSignature===meldSignature(raw)){
    const nearby=(a,b)=>a.center&&b.center&&Math.hypot(a.center[0]-b.center[0],a.center[1]-b.center[1])<6;
    const extra=region.tiles.filter(t=>!old.tiles.some(v=>nearby(t,v)));
    // Preserve known identities independently of completeness. Unchanged
    // melds do not prove that no new discard was missed.
    const candidate={...region,tiles:[...old.tiles,...extra.map((t,i)=>({...t,column:[...old.tiles,...extra.slice(0,i)].filter(v=>v.row===t.row).length}))]};
    const ordered=extra.every((t,i)=>{
     const previous=candidate.tiles[old.tiles.length+i-1];
     if(t.row>previous.row)return t.row===previous.row+1;
     if(t.row!==previous.row)return false;
     const physical=r.physical_positions?.[position]??position;
     const axis=['self','opposite'].includes(physical)?0:1,sign=['opposite','right'].includes(physical)?-1:1;
     return sign*(t.center[axis]-previous.center[axis])>0;
    });
    if(ordered&&(!extra.length||verifiedMarkerExtension(old,candidate))){
     if(result===raw)result=structuredClone(raw);
     region=result.rivers[position];
     region.tiles=candidate.tiles.map(t=>{
      const fresh=region.tiles.find(v=>nearby(t,v)&&v.tile===t.tile);
      return fresh?{...fresh,row:t.row,column:t.column}:{...structuredClone(t),tracking:{source:source.id,reason:'confirmed river retained; all melds unchanged'}};
     });
     region.complete=verifiedMarkerExtension(old,region);
     region.completeness_source=region.complete?'confirmed-prefix-and-accounted-visible-tail':'known-prefix-only-tail-unverified';
    }
   }
   if(old&&region&&!region.complete&&verifiedMarkerExtension(old,region)){
    if(result===raw)result=structuredClone(raw);
    region=result.rivers[position];region.complete=true;
    region.completeness_source='unchanged-prefix-and-contiguous-decoded-markers';
   }
   if(region?.complete&&!region.temporally_tracked&&!region.tiles.some(t=>t.tracking)){
    // Keep direct visual evidence independently of the decision anchor. Never
    // promote a reconstructed observation into a new recognition source.
    if(claim&&(region.tiles.length!==claim.slot+1||region.tiles.at(-1)?.tile!==claim.tile))this.calledTails.delete(position);
    this.sources.set(position,{id:raw.id,round:structuredClone(r),meldSignature:meldSignature(raw),rivers:{[position]:structuredClone(region)}});
   }else if(this.sources.has(position))result=trackOccludedRivers(this.sources.get(position),result);
  }
  return result;
 }
}

function meldSignature(frame){
 const groups=[frame.own_melds,...GAME.opponents.map(p=>frame.opponent_melds?.[p])];
 return groups.every(g=>g?.complete)?JSON.stringify(groups.map(g=>g.groups.map(m=>({kind:m.kind,tiles:m.tiles,calledIndex:m.calledIndex,fromRelative:m.fromRelative})))):null;
}

export function verifiedMarkerExtension(old,next){
 if(!old.complete||!old.tiles.length||next.tiles.length<old.tiles.length)return false;
 // Failed reads at known occupied locations do not revoke past evidence.
 // A rejection at a new location still leaves the new event unresolved.
 if(next.rejected?.some(t=>!t.center||!old.tiles.some(v=>v.center&&Math.hypot(v.center[0]-t.center[0],v.center[1]-t.center[1])<6)))return false;
 // An undecoded occupied outline may be a NEW tail tile. Old history cannot
 // fill it. A non-growing prefix also needs direct outline coverage.
 const boxes=next.face_boxes;
 const inside=(t,b)=>t.center&&t.center[0]>=b[0]-2&&t.center[0]<=b[0]+b[2]+2&&t.center[1]>=b[1]-2&&t.center[1]<=b[1]+b[3]+2;
 if(Number.isInteger(next.face_count)&&next.face_count>next.tiles.length)return false;
 if(boxes?.some(b=>!next.tiles.some(t=>inside(t,b))))return false;
 if(next.tiles.length===old.tiles.length&&(!boxes?.length||boxes.some(b=>next.tiles.filter(t=>inside(t,b)).length!==1)))return false;
 const distance=(a,b)=>Math.hypot(a.center[0]-b.center[0],a.center[1]-b.center[1]);
 if(old.tiles.some((t,i)=>t.tile!==next.tiles[i]?.tile||t.sideways!==next.tiles[i]?.sideways||distance(t,next.tiles[i])>6))return false;
 // All new identities must be directly decoded, in consecutive row/column
 // slots, with normal spacing. A missing new marker cannot pass this check.
 const tiles=next.tiles;
 // The prefix was already verified. Requiring it to be freshly decoded
 // defeats temporal tracking and blocks a decision behind an old overlay.
 // Only new events require fresh color/identity evidence.
 if(tiles.slice(old.tiles.length).some(t=>t.tracking||!t.color?.verified))return false;
 if(tiles.some(t=>!Number.isInteger(t.row)||!Number.isInteger(t.column)))return false;
 for(let i=0;i<tiles.length;i++)if(tiles[i].row*6+tiles[i].column!==i)return false;
 if(tiles.length===old.tiles.length)return true;
 const gaps=old.tiles.slice(1).flatMap((t,i)=>t.row===old.tiles[i].row?[distance(t,old.tiles[i])]:[]).sort((a,b)=>a-b);
 if(!gaps.length)return false;
 const pitch=gaps[Math.floor(gaps.length/2)];
 for(let i=old.tiles.length;i<tiles.length;i++){
  const a=tiles[i-1],b=tiles[i];
  if(a.row===b.row&&(distance(a,b)<pitch*.55||distance(a,b)>pitch*1.65))return false;
  if(a.row!==b.row){
   const priorRowStart=tiles[(b.row-1)*6];
   if(!priorRowStart||distance(priorRowStart,b)<pitch*.45||distance(priorRowStart,b)>pitch*2.5)return false;
  }
 }
 return true;
}

// Confirmed melds are monotone within a hand, including our own melds.
// Pixel completeness is not a precondition for retaining confirmed history.
export class MeldObservationCache {
 constructor(){this.round=null;this.sources=new Map();}
 apply(raw){
  const identity=roundIdentity(raw);if(!identity)return raw;
  const key=JSON.stringify(identity);
  if(key!==this.round){this.round=key;this.sources.clear();}
  let out=raw;
  const norm=t=>t.replace(/0$/,'5');
  const same=(a,b)=>a.kind===b.kind&&a.fromRelative===b.fromRelative&&a.calledIndex===b.calledIndex&&a.tiles[a.calledIndex]===b.tiles[b.calledIndex]&&
   [...a.tiles].sort().join(' ')===[...b.tiles].sort().join(' ');
  const kong=(a,b)=>a.kind==='PENG'&&['BUGANG','GANG'].includes(b.kind)&&
   a.fromRelative===b.fromRelative&&a.calledIndex===b.calledIndex&&b.tiles.length===4&&
   a.tiles.every(t=>norm(t)===norm(b.tiles[0]))&&b.tiles.every(t=>norm(t)===norm(a.tiles[0]));
  const overlap=(a,b)=>a.centers?.some(c=>b.centers?.some(d=>Math.hypot(c[0]-d[0],c[1]-d[1])<12));
  for(const p of GAME.positions){
   const group=p==='self'?raw.own_melds:raw.opponent_melds?.[p];
   const old=this.sources.get(p);
   // Never promote an inferred concealed kong or retained pixels to a new
   // confirmed meld. Fresh exact groups can still extend known history.
   const fresh=group?.complete&&!group.tracking?(group.groups??[]).filter(g=>!g.estimated&&!g.tracking):[];
   if(!old){
    if(group?.complete&&!group.tracking&&fresh.length===(group.groups??[]).length)
     this.sources.set(p,{id:raw.id,groups:structuredClone(fresh)});
    continue;
   }
   const rest=[...fresh],groups=[];
   for(const known of old.groups){
    let i=rest.findIndex(g=>same(known,g)||kong(known,g));
    if(i>=0)groups.push(rest.splice(i,1)[0]);
    else groups.push(known);
   }
   for(const g of rest)if(!groups.some(o=>overlap(o,g))&&groups.length<4)groups.push(g);
   const retained=old.groups.some(g=>!fresh.some(n=>same(g,n)||kong(g,n)));
   const complete=group?.complete&&groups.length===(group.groups??[]).length&&groups.every((g,i)=>same(g,group.groups[i]));
   this.sources.set(p,{id:raw.id,groups:structuredClone(groups)});
   if(complete)continue;
   // With no prior melds an unread band might contain a NEW call: do not
   // declare it empty. With known melds, preserve them while new faces retry.
   if(!groups.length)continue;
   if(out===raw)out=structuredClone(raw);
   const merged={...group,complete:true,groups:structuredClone(groups),reason:null,
    historyRetained:retained,recognitionComplete:!retained&&group?.complete===true};
   delete merged.tracking;
   if(p==='self')out.own_melds=merged;
   else {out.opponent_melds??={};out.opponent_melds[p]=merged;}
  }
  return out;
 }
}

export function trackOccludedRivers(previous,current){
 const a=previous.round,b=current.round;
 if(!a||!b||a.wind!==b.wind||a.hand_number?.value!==b.hand_number?.value||a.counters?.honba!==b.counters?.honba||JSON.stringify(a.seat_identity?.seats)!==JSON.stringify(b.seat_identity?.seats))return current;
 const out=structuredClone(current);let changed=false;
 for(const position of GAME.positions){
  const old=previous.rivers?.[position],next=out.rivers?.[position];
  if(old?.complete&&next&&!next.complete&&meldSignature(previous)&&meldSignature(previous)===meldSignature(current)){
   const near=(a,b)=>a.center&&b.center&&Math.hypot(a.center[0]-b.center[0],a.center[1]-b.center[1])<6;
   const candidate={...next,tiles:[...old.tiles.map(t=>{
    const fresh=next.tiles.find(n=>near(n,t)&&n.tile===t.tile&&n.sideways===t.sideways);
    return fresh??{...t,tracking:{source:previous.id,reason:'confirmed history; current old face occluded'}};
   }),...next.tiles.filter(t=>!old.tiles.some(v=>near(t,v)))]};
   if(verifiedMarkerExtension(old,candidate)){
    next.tiles=candidate.tiles;next.complete=true;
    next.completeness_source='confirmed-history-and-current-new-events';
    changed=true;continue;
   }
  }
  if(!old?.complete||!next||next.complete||next.rejected?.length||!next.face_boxes||next.face_count!==next.face_boxes.length)continue;
  const inside=(t,box)=>t.center[0]>=box[0]&&t.center[0]<=box[0]+box[2]&&t.center[1]>=box[1]&&t.center[1]<=box[1]+box[3];
  const missing=[];let valid=true,retained=0;
  for(const box of next.face_boxes){
   const found=next.tiles.filter(t=>inside(t,box));
   if(found.length>1){valid=false;break;}
   const known=old.tiles.filter(t=>inside(t,box));
   if(found.length){
    if(known.length===1&&known[0].tile!==found[0].tile){valid=false;break;}
    if(found[0].tracking){
     const priorBox=known.length===1&&old.face_boxes?.find(v=>inside(known[0],v));
     if(!priorBox||known[0].tracking||found[0].tracking.source!==previous.id||Math.abs(box[0]-priorBox[0])>3||Math.abs(box[1]-priorBox[1])>3||Math.abs(box[2]-priorBox[2])>3){valid=false;break;}
     retained++;
    }
    continue;
   }
   if(known.length!==1||known[0].tracking){valid=false;break;}
   const priorBox=old.face_boxes?.find(v=>inside(known[0],v));
   if(!priorBox||Math.abs(box[0]-priorBox[0])>3||Math.abs(box[1]-priorBox[1])>3||Math.abs(box[2]-priorBox[2])>3){valid=false;break;}
   missing.push({...known[0],tracking:{source:previous.id,reason:'previously decoded tile at unchanged occupied river location'}});
  }
  if(!valid||!(missing.length+retained)||missing.length+next.tiles.length!==next.face_count)continue;
  const candidates=[...next.tiles,...missing];
  // Restore established order, then append newly visible tiles in their
  // recognizer order. No newly obscured discard may be invented.
  const ordered=[];
  for(const t of old.tiles){const match=candidates.find(v=>Math.hypot(v.center[0]-t.center[0],v.center[1]-t.center[1])<4&&v.tile===t.tile);if(!match){valid=false;break;}ordered.push(match);}
  if(!valid)continue;
  next.tiles=[...ordered,...candidates.filter(t=>!ordered.includes(t))];
  next.complete=true;next.temporally_tracked=missing.length+retained;changed=true;
 }
 return changed?out:current;
}
