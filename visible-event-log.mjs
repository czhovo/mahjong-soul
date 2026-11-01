const positions=['right','opposite','left'];
const allPositions=['self',...positions];
const meldKey=g=>JSON.stringify([g.kind,[...g.tiles].sort(),g.fromRelative??null,g.calledIndex??null]);
const norm=t=>t?.replace(/0$/,'5');
const key=f=>JSON.stringify([f.round?.wind,f.round?.hand_number?.value,f.round?.counters?.honba,f.round?.seat_identity?.seats]);
const slots=r=>new Map((r?.tiles??[]).flatMap((t,i)=>{
 const n=Number.isInteger(t.row)&&Number.isInteger(t.column)?t.row*6+t.column:r?.complete?i:null;
 return n===null||!t.tile?[]:[[n,t]];
}));
// Display only; never feeds reconstructed requests into the bot session.
export class VisibleEventLog {
 constructor(frame){this.reset(frame);}
 reset(frame){this.doraRound=key(frame??{});this.indicators=frame?.dora?.complete&&!frame.dora.rejected?.length?frame.dora.tiles.map(t=>t.tile):null;this.callSources=new Map();this.callGroups={};for(const p of allPositions){const m=p==='self'?frame?.own_melds:frame?.opponent_melds?.[p];this.callGroups[p]=m?.complete?structuredClone(m.groups):null;}this.round=key(frame??{});this.players={};for(const p of allPositions){const r=frame?.rivers?.[p],m=p==='self'?frame?.own_melds:frame?.opponent_melds?.[p];this.players[p]={slots:slots(r),ready:!!r?.complete,groups:m?.complete?structuredClone(m.groups):null};}}
 observe(frame,{includeSelf=false}={}){
  if(!frame.round?.seat_identity?.verified)return [];
  if(this.round!==key(frame)){this.reset(frame);return [];}
  // Record independently visible new calls before inspecting any river, so
  // owner/source iteration order cannot authorize or suppress a removal.
  for(const owner of allPositions){
   const m=owner==='self'?frame.own_melds:frame.opponent_melds?.[owner],old=this.callGroups[owner];
   if(!m?.complete||m.tracking)continue;
   const rest=[...m.groups];let compatible=true;
   for(const g of old??[]){
    let i=rest.findIndex(v=>meldKey(v)===meldKey(g));
    if(i<0&&g.kind==='PENG')i=rest.findIndex(v=>['GANG','BUGANG'].includes(v.kind)&&norm(v.tiles[0])===norm(g.tiles[0]));
    if(i<0){compatible=false;break;}rest.splice(i,1);
   }
   if(!compatible)continue;
   if(old)for(const g of rest){
    const offset={left:3,opposite:2,right:1}[g.fromRelative];
    if(!['CHI','PENG','GANG'].includes(g.kind)||offset===undefined||!Number.isInteger(g.calledIndex))continue;
    const source=allPositions[(allPositions.indexOf(owner)+offset)%4],slots=this.players[source]?.slots;
    if(!slots?.size)continue;
    const n=Math.max(...slots.keys()),tile=g.tiles[g.calledIndex];
    if(slots.get(n)?.tile===tile)this.callSources.set(source,{slot:n,tile});
   }
   this.callGroups[owner]=structuredClone(m.groups);
  }
  const out=[];
  for(const p of includeSelf?allPositions:positions){
   const old=this.players[p],r=frame.rivers?.[p],m=p==='self'?frame.own_melds:frame.opponent_melds?.[p],seat=frame.round.seat_identity.seats[p];
   const emit=(kind,tiles=[])=>out.push({state:`3 ${seat} ${kind}${tiles.length?' '+tiles.join(' '):''}`,validact:null});
   if(m?.complete&&!m.tracking){
    const rest=[...m.groups],upgrades=[];
    const signature=g=>JSON.stringify([g.kind,[...g.tiles].sort(),g.fromRelative??null]);
    let compatible=true;
    for(const prev of old.groups??[]){
     let i=rest.findIndex(g=>signature(g)===signature(prev));
     if(i>=0){rest.splice(i,1);continue;}
     i=rest.findIndex(g=>prev.kind==='PENG'&&['GANG','BUGANG'].includes(g.kind)&&norm(prev.tiles[0])===norm(g.tiles[0]));
     if(i>=0){upgrades.push(rest.splice(i,1)[0]);continue;}
     compatible=false;break;
    }
    // New groups can be prepended. Never compare physical array indices or
    // roll the committed baseline back on missing/conflicting observations.
    if(compatible){
     if(old.groups){
      for(const g of upgrades)emit('BUGANG',[g.tiles[0]]);
      for(const g of rest)if(['CHI','PENG','GANG','BUGANG','ANGANG'].includes(g.kind))emit(g.kind,g.tiles);
     }
     old.groups=structuredClone(m.groups);
    }
   }
   const current=slots(r);
   if(!old.ready){if(r?.complete){old.slots=current;old.ready=true;}continue;}
   // A smaller recognition result alone NEVER proves a tile was called.
   const call=this.callSources.get(p);
   if(call&&r?.complete&&old.slots.get(call.slot)?.tile===call.tile){
    const prefix=[...old.slots].filter(([n])=>n!==call.slot);
    if(prefix.every(([n,t])=>current.get(n)?.tile===t.tile)&&
       (!current.has(call.slot)||current.get(call.slot).tile!==call.tile)){
     old.slots.delete(call.slot);this.callSources.delete(p);
    }
   }
   let tail=Math.max(-1,...old.slots.keys());
   for(const [n,t] of [...current].sort((a,b)=>a[0]-b[0])){
    if(old.slots.has(n)||t.tracking)continue;
    emit(t.sideways===true?'LIZHI':'PLAY',[t.tile]);old.slots.set(n,t);tail=n;
   }
  }
  const indicators=frame.dora;
  if(indicators?.complete&&!indicators.rejected?.length){
   const now=indicators.tiles.map(t=>t.tile);
   if(this.doraRound!==this.round){this.doraRound=this.round;this.indicators=null;}
   if(this.indicators&&now.length>this.indicators.length&&this.indicators.every((t,i)=>t===now[i])){
    for(let i=this.indicators.length;i<now.length;i++)out.push({state:`DORA ${now[i]} ${i}`,validact:null});
   }
   if(!this.indicators||now.length>=this.indicators.length)this.indicators=now;
  }
  return out;
 }
}
