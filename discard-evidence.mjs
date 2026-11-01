const positions=['self','right','opposite','left'];
const roundKey=f=>JSON.stringify([f.round?.wind,f.round?.hand_number?.value,f.round?.counters?.honba,f.round?.seat_identity?.seats]);
export class DiscardEvidence {
 constructor(){this.round=null;this.players={};this.used=new Set();this.motions=new Map();}
 update(frame,motions=[]){
  if(!frame.round?.seat_identity?.verified)return;
  const key=roundKey(frame);
  if(key!==this.round){this.round=key;this.players={};this.used.clear();this.motions.clear();}
  for(const e of motions)if(['tedashi','tsumogiri'].includes(e.mode))this.motions.set(`${e.position}:${e.drawAt}:${e.id}`,e);
  // Retain animation evidence while a tile identity is temporarily unread.
  while(this.motions.size>256)this.motions.delete(this.motions.keys().next().value);
  for(const pos of positions.slice(1)){
   const river=frame.rivers?.[pos];if(!river)continue;
   const old=this.players[pos];
   const physical=river.tiles.every(t=>Number.isInteger(t.row)&&Number.isInteger(t.column));
   if(!river.complete&&!physical)continue;
   const observed=new Map(river.tiles.map((t,i)=>[physical?t.row*6+t.column:i,t]));
   // Preserve physical holes: compacting readable tiles shifts every later
   // motion to the wrong discard. Incomplete frames cannot remove old slots.
   const length=Math.max(0,...[...observed.keys()].map(i=>i+1),...(!river.complete?[old?.tiles.length??0]:[]));
   const tiles=Array.from({length},(_,i)=>observed.get(i)?.tile??(!river.complete?old?.tiles[i]:null)??null);
   // A single incomplete-looking decode must not erase a committed suffix.
   // A real called-away discard can be accepted on the next matching frame.
   if(old&&tiles.length<old.tiles.length){
    const shrink=JSON.stringify(tiles);
    if(old.shrink!==shrink){old.shrink=shrink;continue;}
   }else if(old)delete old.shrink;
   let entries=[];
   if(old){
    let prefix=0;while(prefix<old.tiles.length&&prefix<tiles.length&&old.tiles[prefix]===tiles[prefix])prefix++;
    entries=old.entries.slice(0,prefix);
    // Only a preserved prefix or one called-away final tile is unambiguous.
    if(tiles.length>old.tiles.length){
     // Correcting an older decoded face while appending a discard does not
     // create two new discards competing for the same motion evidence.
     for(let i=prefix;i<old.tiles.length;i++)entries[i]=old.tiles[i]===tiles[i]?old.entries[i]:old.tiles[i]===null?{...old.entries[i],tile:tiles[i]}:{tile:tiles[i]};
     for(let i=old.tiles.length;i<tiles.length;i++)entries[i]=tiles[i]===null&&river.complete?{tile:null}:{tile:tiles[i],from:old.at,to:frame.capturedAt};
    }else if(prefix===old.tiles.length-1&&old.tiles[prefix]!==null){
     for(let i=prefix;i<tiles.length;i++)entries[i]={tile:tiles[i],from:old.at,to:frame.capturedAt};
    }
   }
   for(let i=0;i<tiles.length;i++)entries[i]??=old&&old.tiles[i]===null?{...old.entries[i],tile:tiles[i]}:old&&old.tiles[i]===tiles[i]?old.entries[i]:{tile:tiles[i]};
   const candidates=[...this.motions.values()].filter(e=>e.position===pos&&!this.used.has(`${pos}:${e.drawAt}:${e.id}`));
   // River appearance precedes hand consolidation. Associate the completed
   // animation, not just events ending within 300 ms of river appearance.
   const compatible=(e,t)=>Number.isFinite(t.from)&&!t.evidence&&e.at>=t.from-1500&&e.at<=t.to+1500&&e.drawAt<=t.to;
   for(const e of candidates){
    const hits=entries.filter(t=>compatible(e,t));
    if(hits.length!==1||candidates.filter(other=>compatible(other,hits[0])).length!==1)continue;
    hits[0].evidence={...e};this.used.add(`${pos}:${e.drawAt}:${e.id}`);
   }
   // When several discards arrive together, pair complete motion sequences
   // in order. Never guess when the number of motions and discards differs.
   const pending=entries.filter(t=>Number.isFinite(t.from)&&!t.evidence);
   const remaining=candidates.filter(e=>!this.used.has(`${pos}:${e.drawAt}:${e.id}`)&&pending.some(t=>compatible(e,t))).sort((a,b)=>a.drawAt-b.drawAt);
   if(pending.length>1&&remaining.length===pending.length&&remaining.every((e,i)=>compatible(e,pending[i]))){
    remaining.forEach((e,i)=>{pending[i].evidence={...e};this.used.add(`${pos}:${e.drawAt}:${e.id}`);});
   }
   for(let i=0;i<tiles.length;i++){
    // User rule: an observed vacancy in the original hand means tedashi;
    // otherwise use tsumogiri, including missing animation samples. Keep the
    // fallback separate so a later matched vacancy can still replace it.
    const evidence=entries[i].evidence??{mode:'tsumogiri',source:'no-original-hand-gap-observed',inferred:true};
    const face=observed.get(i);if(!face)continue;
    face.discardMode=evidence.mode;
    face.discardEvidence=evidence;
   }
   this.players[pos]={tiles,entries,at:frame.capturedAt};
  }
 }
}
// Align the visible river with surviving public discard events, removing only
// discards explicitly consumed by a call. Repeated tile names remain separate.
export function annotateDiscardRequests(requests,frame){
 if(!frame?.round?.seat_identity?.verified)return requests;
 const alive=[[],[],[],[]];let last=null;
 for(let i=0;i<requests.length;i++){
  const w=requests[i].state?.split(/\s+/)??[];
  if(w[0]==='0'){for(const a of alive)a.length=0;last=null;continue;}
  if(w[0]!=='3')continue;const seat=Number(w[1]);if(!alive[seat])continue;
  if(['CHI','PENG','GANG'].includes(w[2])&&last){const a=alive[last.seat];if(a.at(-1)?.index===last.index)a.pop();last=null;}
  const tile=['PLAY','LIZHI'].includes(w[2])?w[3]:['CHI','PENG'].includes(w[2])?w[6]:null;
  if(tile){last={seat,index:i,tile,call:['CHI','PENG'].includes(w[2])};alive[seat].push(last);}
 }
 const out=requests.map(r=>({...r}));
 for(const pos of positions){
  const r=frame.rivers?.[pos],seat=frame.round.seat_identity.seats[pos],a=alive[seat];
  if(!r?.complete||!a||a.length!==r.tiles.length||a.some((x,i)=>x.tile!==r.tiles[i].tile))continue;
  for(let i=0;i<a.length;i++){
   const t=r.tiles[i];if(a[i].call)continue;
   if(['tedashi','tsumogiri'].includes(t.discardMode)&&t.discardEvidence&&!t.discardEvidence.inferred){
    out[a[i].index].playDrawnTile=t.discardMode==='tsumogiri';
    out[a[i].index].discardOriginEvidence=t.discardEvidence;
   }
  }
 }
 return out;
}
