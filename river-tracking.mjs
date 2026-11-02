// Preserve identities of already observed immutable river tiles when an overlay
// hides a marker. This is temporal tracking, explicitly not fresh recognition.
export class RiverObservationCache {
 constructor(){this.sources=new Map();this.identity=null;}
 conflicts(raw){
  const r=raw.round;
  if(!r?.seat_identity?.verified||JSON.stringify([r.wind,r.hand_number?.value,r.counters?.honba,r.seat_identity.seats])!==this.identity)return [];
  return [...this.sources].flatMap(([position,source])=>(raw.rivers?.[position]?.tiles??[]).flatMap(t=>{
   const old=source.rivers[position].tiles.find(v=>v.center&&t.center&&Math.hypot(v.center[0]-t.center[0],v.center[1]-t.center[1])<6);
   return old&&(old.tile!==t.tile||old.sideways!==t.sideways)?[{position,previous:old.tile,observed:t.tile,previousSideways:old.sideways,observedSideways:t.sideways}]:[];
  }));
 }
 apply(raw){
  const r=raw.round;
  const valid=r&&Number.isInteger(r.wind)&&Number.isInteger(r.hand_number?.value)&&Number.isInteger(r.counters?.honba)&&r.seat_identity?.verified===true;
  const identity=valid?JSON.stringify([r.wind,r.hand_number.value,r.counters.honba,r.seat_identity.seats]):null;
  // An unreadable animation is not evidence of a new round. Keep prior
  // evidence dormant until the same identity is independently visible again.
  if(identity&&identity!==this.identity){this.sources.clear();this.identity=identity;}
  if(!identity)return raw;
  let result=raw;
  for(const position of ['self','right','opposite','left']){
   let region=result.rivers?.[position];
   const source=this.sources.get(position),old=source?.rivers?.[position];
   const unchangedMelds=source?.meldSignature&&source.meldSignature===meldSignature(raw);
   if(old&&region?.complete&&unchangedMelds&&region.tiles.length<old.tiles.length){
    if(result===raw)result=structuredClone(raw);
    region=result.rivers[position];region.complete=false;
   }
   if(old&&region&&(!source.meldSignature||unchangedMelds)){
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
     const axis=['self','opposite'].includes(position)?0:1,sign=['opposite','right'].includes(position)?-1:1;
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
    this.sources.set(position,{id:raw.id,round:structuredClone(r),meldSignature:meldSignature(raw),rivers:{[position]:structuredClone(region)}});
   }else if(this.sources.has(position))result=trackOccludedRivers(this.sources.get(position),result);
  }
  return result;
 }
}

function meldSignature(frame){
 const groups=[frame.own_melds,...['right','opposite','left'].map(p=>frame.opponent_melds?.[p])];
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

export class MeldObservationCache {
 constructor(){this.round=null;this.sources=new Map();}
 apply(raw){
  const r=raw.round;if(!r?.seat_identity?.verified)return raw;
  const identity=JSON.stringify([r.wind,r.hand_number?.value,r.counters?.honba,r.seat_identity.seats]);
  if(identity!==this.round){this.round=identity;this.sources.clear();}
  let out=raw;
  for(const p of ['right','opposite','left']){
   const group=raw.opponent_melds?.[p],faces=raw.opponent_meld_faces?.[p];
   const old=this.sources.get(p);
   if(group?.complete&&faces?.complete){
    const key=g=>JSON.stringify([g.kind,g.tiles,g.calledIndex,g.fromRelative]);
    const previous=old?.group.groups??[],keys=previous.map(key);
    const matches=g=>previous.some(o=>key(o)===key(g)||(!o.estimated&&g.estimated&&g.kind==='ANGANG'&&
     ['PENG','GANG','BUGANG'].includes(o.kind)&&o.tiles.every(t=>t===g.tiles[0])));
    if(group.groups.length<=previous.length&&group.groups.every(matches)&&previous.every(g=>!g.estimated)&&
       (group.groups.length<previous.length||group.groups.some(g=>!keys.includes(key(g))))){
     // An exposed set cannot leave the table within one hand.
     if(out===raw)out=structuredClone(raw);
     out.opponent_melds[p]={...structuredClone(old.group),tracking:{source:old.id,reason:'previously visible meld omitted'}};
     continue;
    }
    this.sources.set(p,{id:raw.id,group:structuredClone(group),faces:structuredClone(faces)});continue;
   }
   if(old&&faces&&!faces.tiles.length&&!faces.rejected?.length&&faces.face_boxes?.length>0&&faces.face_boxes.every(b=>b[2]>b[3]*2.5)){
    // A positively detected overlay may retain history, but never supplies a
    // fresh call event. Empty geometry is not evidence of an overlay.
    if(out===raw)out=structuredClone(raw);
    out.opponent_melds[p]={...structuredClone(old.group),tracking:{source:old.id,reason:'occluded; retaining history only'}};
    continue;
   }
   if(!old||!faces||faces.rejected?.length||faces.face_count!==old.faces.face_count||!faces.face_boxes?.length)continue;
   const near=(a,b)=>Math.hypot(a.center[0]-b.center[0],a.center[1]-b.center[1])<6;
   if(!faces.tiles.length||faces.tiles.some(t=>!old.faces.tiles.some(v=>near(t,v)&&t.tile===v.tile)))continue;
   const inside=(t,b)=>t.center[0]>=b[0]&&t.center[0]<=b[0]+b[2]&&t.center[1]>=b[1]&&t.center[1]<=b[1]+b[3];
   if(faces.face_boxes.some(b=>old.faces.tiles.filter(t=>inside(t,b)).length!==1)||old.faces.tiles.some(t=>!faces.face_boxes.some(b=>inside(t,b))))continue;
   if(out===raw)out=structuredClone(raw);
   out.opponent_melds[p]={...structuredClone(old.group),tracking:{source:old.id,reason:'unchanged occupied meld faces'}};
  }
  return out;
 }
}

export function trackOccludedRivers(previous,current){
 const a=previous.round,b=current.round;
 if(!a||!b||a.wind!==b.wind||a.hand_number?.value!==b.hand_number?.value||a.counters?.honba!==b.counters?.honba||JSON.stringify(a.seat_identity?.seats)!==JSON.stringify(b.seat_identity?.seats))return current;
 const out=structuredClone(current);let changed=false;
 for(const position of ['self','right','opposite','left']){
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
