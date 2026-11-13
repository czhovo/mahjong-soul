import {riichiEvents} from './confirmed-riichi.mjs';
import {roundIdentity} from './round-boundary.mjs';
const signature=f=>JSON.stringify(roundIdentity(f));
const sameFace=(a,b)=>a?.tile===b?.tile&&a?.sideways===b?.sideways;
const direct=t=>t&&!t.tracking&&t.color?.verified&&typeof t.sideways==='boolean';
// Map occupied slots back to their originating requests. A claimed discard
// leaves its river; a bundled CHI/PENG also contributes the caller's discard.
export function reviseOlderDiscard(marks,session,raw,conflicts){
 const r=roundIdentity(raw),seen=new Set();
 if(!r||session.pending){marks.clear();return null;}
 const rows=Array.from({length:4},()=>[]);let last=null;
 for(const [index,q] of (session.requests??[]).entries()){
  const w=q.state?.split(' ')??[],seat=Number(w[1]),kind=w[2];
  if(w[0]!=='3')continue;
  if(['CHI','PENG','GANG'].includes(kind)){
   if(!last||seat===last.seat||rows[last.seat].at(-1)!==last)return null;
   rows[last.seat].pop();last=null;
  }
  if(['PLAY','LIZHI'].includes(kind)||(['CHI','PENG'].includes(kind)&&w.length===7)){
   last={index,seat,tile:w.at(-1),kind};rows[seat].push(last);
  }
 }
 for(const c of conflicts){
  const pos=c.position,region=raw.rivers?.[pos],seat=r.seats[pos],row=rows[seat];
  if(pos==='self'||!region?.complete||region.rejected?.length||!row||c.previous===c.observed||c.previousSideways!==c.observedSideways)continue;
  const slot=c.slot,t=region.tiles[slot],old=row[slot];
  if(!direct(t)||t.tile!==c.observed||t.row*6+t.column!==slot||old?.tile!==c.previous||!['PLAY','LIZHI'].includes(old.kind))continue;
  if(row.length>region.tiles.length||!row.every((q,i)=>i===slot||q.tile===region.tiles[i].tile))continue;
  const key=JSON.stringify([r,pos,slot,old.index,old.tile,t.tile]);seen.add(key);
  if(!marks.has(key)){marks.set(key,raw.id);continue;}
  if(marks.get(key)===raw.id)continue;
  const index=old.index,request=session.requests[index],was=request.state,state='3 '+seat+' '+old.kind+' '+t.tile;
  session.requests[index]={...request,state};
  if(last===old&&session.ledger?.lastPlayer===seat&&session.ledger.lastDiscard===old.tile)session.ledger={...session.ledger,lastDiscard:t.tile};
  marks.clear();return {was,state,pos,slot,index,tile:structuredClone(t),historical:true};
 }
 for(const k of marks.keys())if(!seen.has(k))marks.delete(k);
 return null;
}
const meldKey=(f,p)=>{const m=p==='self'?f.own_melds:f.opponent_melds?.[p];
 return m?.complete&&!m.historyRetained&&!m.groups.some(g=>g.tracking||g.estimated)?JSON.stringify(m.groups.map(g=>[g.kind,g.tiles,g.fromRelative,g.calledIndex]).sort()):null;};
// Only an actually appended, as-yet-unanswered opponent discard can be revised.
// Never infer the request index from the tile name: duplicate discards are common.
export function newObservedTail(session,frame){
 const request=session.requests?.at(-1),w=request?.state?.split(' ')??[],r=roundIdentity(frame);
 if(!r||w.length!==4||w[0]!=='3'||!['PLAY','LIZHI'].includes(w[2])||Number(w[1])===session.seat)return null;
 const pos=Object.keys(r.seats).find(p=>r.seats[p]===Number(w[1])),river=frame.rivers?.[pos],slot=(river?.tiles?.length??0)-1,t=river?.tiles[slot];
 if(!river?.complete||river.rejected?.length||!direct(t)||t.tile!==w[3]||riichiEvents([{state:`3 ${w[1]} ${t.sideways?'LIZHI':'PLAY'} ${t.tile}`}],session.requests.slice(0,-1))[0].state!==request.state||t.row*6+t.column!==slot)return null;
 return {request,index:session.requests.length-1,pos,slot,frame,proposal:null};
}
export function reviseObservedTail(mark,session,raw){
 if(!mark)return null;
 const {index,pos,slot,request,frame}=mark,old=frame.rivers[pos].tiles,river=raw.rivers?.[pos],t=river?.tiles[slot];
 const r=roundIdentity(raw);
 if(session.pending||!r||signature(raw)!==signature(frame)||session.requests.length!==index+1||session.requests[index]!==request||session.responses[index]!=='PASS'||
    !river?.complete||river.rejected?.length||river.tiles.length!==slot+1||!direct(t)||t.row*6+t.column!==slot||sameFace(t,old[slot])||
    !old.slice(0,slot).every((v,i)=>sameFace(v,river.tiles[i]))||
    Object.keys(r.seats).some(p=>meldKey(frame,p)===null||meldKey(raw,p)!==meldKey(frame,p))){mark.proposal=null;return null;}
 const seat=r.seats[pos],state=riichiEvents([{state:`3 ${seat} ${t.sideways?'LIZHI':'PLAY'} ${t.tile}`}],session.requests.slice(0,index))[0].state;
 if(mark.proposal?.state!==state){mark.proposal={state,id:raw.id};return null;}
 if(mark.proposal.id===raw.id||!raw.id||session.ledger.lastPlayer!==seat||session.ledger.lastDiscard!==old[slot].tile)return null;
 const was=request.state;
 session.requests[index]={...request,state};session.ledger={...session.ledger,lastDiscard:t.tile};
 return {was,state,pos,slot,index,tile:structuredClone(t)};
}
