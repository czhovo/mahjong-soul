import {roundIdentity} from './round-boundary.mjs';
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const shape=m=>(m?.groups??[]).map(({kind,tiles,calledIndex,fromRelative})=>({kind,tiles,calledIndex,fromRelative}));
export function completeDecodedRivers(frame){
 for(const river of Object.values(frame.rivers??{})){
  // A native retry can rediscover a retained prefix marker. Collapse only
  // identical identities at the same physical location, never equal tiles
  // at different discard positions.
  const unique=[],removedByRow=new Map();
  for(const t of river.tiles??[]){
   if(unique.some(v=>v.tile===t.tile&&v.sideways===t.sideways&&v.center&&t.center&&Math.hypot(v.center[0]-t.center[0],v.center[1]-t.center[1])<6)){
    removedByRow.set(t.row,(removedByRow.get(t.row)??0)+1);
   }else unique.push({...t,column:Number.isInteger(t.column)?t.column-(removedByRow.get(t.row)??0):t.column});
  }
  if(unique.length!==(river.tiles??[]).length){
   const inside=(t,b)=>t.center&&t.center[0]>=b[0]-3&&t.center[0]<=b[0]+b[2]+3&&t.center[1]>=b[1]-3&&t.center[1]<=b[1]+b[3]+3;
   const seen=new Set(),keep=[];
   for(const [i,b] of (river.face_boxes??[]).entries()){
    const matches=unique.map((t,j)=>inside(t,b)?j:-1).filter(j=>j>=0);
    if(matches.length===1){if(seen.has(matches[0]))continue;seen.add(matches[0]);}
    keep.push(i);
   }
   river.tiles=unique;
   river.face_boxes=keep.map(i=>river.face_boxes[i]);
   if(river.face_polygons)river.face_polygons=keep.map(i=>river.face_polygons[i]);
   river.face_count=river.face_boxes.length;river.complete=false;
   river.evidenceRepair='duplicate-physical-marker-removed';
  }
  const tiles=river.tiles??[],boxes=river.face_boxes??[];
  const inside=(t,b)=>t.center&&t.center[0]>=b[0]&&t.center[0]<=b[0]+b[2]&&t.center[1]>=b[1]&&t.center[1]<=b[1]+b[3];
  if(river.rejected?.length){
   river.rejected=river.rejected.filter(t=>{
    const near=tiles.filter(v=>v.color?.verified&&v.center&&t.center&&Math.hypot(v.center[0]-t.center[0],v.center[1]-t.center[1])<6);
    const faces=boxes.filter(b=>inside(t,b));
    if(near.length!==1||faces.length!==1||!inside(near[0],faces[0])||tiles.filter(v=>inside(v,faces[0])).length!==1)return true;
    (river.superseded_rejected??=[]).push(t);return false;
   });
  }
  if(tiles.some((t,i)=>tiles.slice(0,i).some(v=>v.center&&t.center&&Math.hypot(v.center[0]-t.center[0],v.center[1]-t.center[1])<6))){river.complete=false;continue;}
  if(river.complete||river.rejected?.length||!boxes.length||tiles.length<boxes.length)continue;
  if(!tiles.every(t=>t.color?.verified&&t.center&&typeof t.sideways==='boolean'))continue;
  // Accounted visible boxes can still omit an occluded historical slot.
  // Leave such a region for history tracking instead of declaring it fresh.
  if(tiles.some((t,i)=>Number.isInteger(t.row)&&Number.isInteger(t.column)&&t.row*6+t.column>i))continue;
  const used=new Set();
  if(boxes.every(([x,y,w,h])=>{
   const i=tiles.findIndex((t,i)=>!used.has(i)&&t.center[0]>=x-3&&t.center[0]<=x+w+3&&t.center[1]>=y-3&&t.center[1]<=y+h+3);
   if(i<0)return false;used.add(i);return true;
  })){river.complete=true;river.evidenceRepair='all-outlines-accounted-by-decoded-faces';}
 }
 return frame;
}
// Repair observation metadata, not game history. Never transplant a later
// call or a new river tail into the committed earlier position.
export function repairAnchorEvidence(before,current){
 if(!before||!current||!roundIdentity(before)||!equal(roundIdentity(before),roundIdentity(current)))return before;
 const result=structuredClone(before);
 for(const p of ['right','opposite','left']){
  const old=before.opponent_melds?.[p],fresh=current.opponent_melds?.[p];
  const band=before.opponent_meld_faces?.[p],next=current.opponent_meld_faces?.[p];
  const covered=t=>(band?.tiles??[]).some(n=>n.tile===t.tile&&n.center&&t.center&&Math.hypot(n.center[0]-t.center[0],n.center[1]-t.center[1])<=8)||
   (band?.face_boxes??[]).some(([x,y,w,h])=>t.center&&t.center[0]>=x&&t.center[0]<=x+w&&t.center[1]>=y&&t.center[1]<=y+h);
  const sameBand=band?.tiles?.length&&next?.tiles?.length&&!(band.rejected?.length)&&
   band.tiles.every(t=>next.tiles.some(n=>n.tile===t.tile&&Math.hypot(n.center[0]-t.center[0],n.center[1]-t.center[1])<=8))&&
   next.tiles.every(covered);
  if(old&&!old.complete&&fresh?.complete&&(equal(shape(old),shape(fresh))||sameBand))
   result.opponent_melds[p]={...structuredClone(fresh),evidenceRepair:'same-melds-fresh-observation'};
 }
 for(const p of ['self','right','opposite','left']){
  const old=before.rivers?.[p],fresh=current.rivers?.[p];
  if(!old?.tiles?.length||!fresh?.complete)continue;
  const indices=old.tiles.map(t=>fresh.tiles.findIndex(n=>n.tile===t.tile&&n.sideways===t.sideways&&t.center&&n.center&&Math.hypot(t.center[0]-n.center[0],t.center[1]-n.center[1])<=8));
  if(indices.some((n,i)=>n<0||(i&&n<=indices[i-1])))continue;
  const prefix=fresh.tiles.slice(0,indices.at(-1)+1);
  if(prefix.length>old.tiles.length)
   result.rivers[p]={...old,tiles:structuredClone(prefix),evidenceRepair:'old-position-holes-only'};
  // A later complete read can disprove a duplicate outline, but cannot
  // account for a distinct missing face or append its new tail to history.
  const boxes=(fresh.face_boxes??[]).filter(([x,y,w,h])=>prefix.some(t=>t.center&&t.center[0]>=x-3&&t.center[0]<=x+w+3&&t.center[1]>=y-3&&t.center[1]<=y+h+3));
  const overlap=([x,y,w,h],[a,b,c,d])=>Math.max(0,Math.min(x+w,a+c)-Math.max(x,a))*Math.max(0,Math.min(y+h,b+d)-Math.max(y,b));
  if(!old.complete&&!old.rejected?.length&&boxes.length===prefix.length&&
     prefix.every(t=>t.color?.verified)&&old.face_boxes?.length&&
     old.face_boxes.every(box=>boxes.some(b=>overlap(box,b)>=box[2]*box[3]*0.25))){
   result.rivers[p]={...result.rivers[p],tiles:structuredClone(prefix),face_boxes:structuredClone(boxes),face_count:boxes.length,complete:true,evidenceRepair:'same-prefix-fresh-outlines'};
  }
 }
 completeDecodedRivers(result);
 return equal(result,before)?before:result;
}
