const positions=['self','right','opposite','left'];
export function hasNoCalls(frame){
 return [frame.own_melds,...positions.slice(1).map(p=>frame.opponent_melds?.[p])].every(m=>m?.complete&&!m.groups.length);
}
export function retainedRivers(history=[]){
 const rivers=Array.from({length:4},()=>[]);let last=null;
 for(const q of history){
  const w=q.state?.split(/\s+/)??[];if(w[0]!=='3')continue;
  const seat=Number(w[1]);
  if(['PLAY','LIZHI'].includes(w[2])){rivers[seat].push({tile:w[3],sideways:w[2]==='LIZHI',historySource:true});last=seat;}
  else if(['CHI','PENG','GANG'].includes(w[2])){
   if(last!==null)rivers[last].pop();
   if(w[2]!=='GANG'){rivers[seat].push({tile:w[6],sideways:false,historySource:true});last=seat;}
  }
 }
 return rivers;
}
export function mergeKnownRiver(known,observed){
 if(!known.length)return structuredClone(observed);
 if(!observed.length)return structuredClone(known);
 // Missing old prefixes are not evidence that those discards disappeared.
 const alignments=[];
 for(let offset=1-observed.length;offset<known.length;offset++){
  const begin=Math.max(0,offset),end=Math.min(known.length,offset+observed.length),n=end-begin;
  if(n&&known.slice(begin,end).every((t,i)=>t.tile===observed[begin+i-offset].tile&&!!t.sideways===!!observed[begin+i-offset].sideways))
   alignments.push({offset,n});
 }
 alignments.sort((a,b)=>b.n-a.n);
 if(alignments.length&&!(alignments[1]?.n===alignments[0].n)){
  const {offset}=alignments[0],begin=Math.min(0,offset),end=Math.max(known.length,offset+observed.length),result=[];
  for(let i=begin;i<end;i++)result.push({...known[i],...observed[i-offset]});
  return result;
 }
 // Conflicting rereads cannot overwrite committed identities.
 return structuredClone(known);
}
export function exactNoCallOrder(frame,rivers,remaining,own){
 if(!hasNoCalls(frame)||frame.round.remaining?.estimated)return null;
 const seats=frame.round.seat_identity.seats,queues=Array.from({length:4},()=>[]);
 for(const p of positions)queues[seats[p]]=rivers[p];
 const count=queues.reduce((n,q)=>n+q.length,0);
 if(count+(own?1:0)!==70-remaining)return null;
 const events=[];
 for(let i=0;i<count;i++){
  const seat=i%4,t=queues[seat][Math.floor(i/4)];if(!t)return null;
  events.push({state:`3 ${seat} DRAW`,validact:null,historyOrderCertain:true},
   {state:`3 ${seat} ${t.sideways?'LIZHI':'PLAY'} ${t.tile}`,validact:null,historyOrderCertain:true});
 }
 if(own&&count%4!==seats.self)return null;
 return events;
}
