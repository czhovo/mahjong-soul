import {depositsConsistent} from './riichi-deposits.mjs';
import {declaredSeats} from './confirmed-riichi.mjs';
import {canonicalMelds} from './meld-events.mjs';
import {estimateWall,fillWall} from './wall-estimate.mjs';
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const sorted=a=>[...a].sort().join(' ');
const positions=['self','right','opposite','left'];
// Enumerate only events whose tile identities exist in visible river/meld
// differences. Multiple consistent orders may use the user-authorized estimate.
export function chainedCallSpan(decision,before,after,{checkpoints=[],publicStart=null}={}){
 const action=/^(PLAY|LIZHI) ([WBT][0-9]|Z[1-7])$/.exec(decision.output.response);
 const declaring=action?.[1]==='LIZHI',discardTile=publicStart?.tile??action?.[2];
 const riichi=declaring||declaredSeats(decision.input?.requests).has(before.round?.seat_identity?.seats?.self)||before.rivers?.self?.tiles.some(t=>t.sideways===true);
 const a=before.round,b=after.round;
 if(!action||!before.hand.complete||!after.hand.complete||a.wind!==b.wind||a.hand_number.value!==b.hand_number.value||a.counters.honba!==b.counters.honba||!a.seat_identity.verified||!b.seat_identity.verified||!eq(a.seat_identity.seats,b.seat_identity.seats))throw Error('Unaccounted anchor or round');
 const seats=a.seat_identity.seats,own=seats.self,initialActor=publicStart?.seat??own,remaining=[...decision.visibleHand],i=remaining.indexOf(discardTile);
 if(!publicStart){if(i<0)throw Error('Absent anchor discard');remaining.splice(i,1);}
 else if(!Number.isInteger(initialActor)||initialActor<0||initialActor>3)throw Error('Invalid public discard actor');
 const visible=after.hand.tiles.map(t=>t.tile);let nextDraw=null;
 if(visible.length===remaining.length+1){
  const tiles=after.hand.tiles;
  if(b.turn.position!=null&&b.turn.position!=='self')throw Error('Unproved own draw');
  nextDraw=visible.pop();
 }
 if(sorted(remaining)!==sorted(visible))throw Error('Unaccounted own hand');
 const queues={},calls=[],declarations=new Set();
 for(const p of positions){
  let old=before.rivers[p];const next=after.rivers[p];
  if(publicStart&&publicStart.phase!=='draw'&&seats[p]===initialActor){
   if(old.tiles.at(-1)?.tile!==discardTile)throw Error('Public source discard not last');
   old={...old,tiles:old.tiles.slice(0,-1)};
   // The committed discard has since been called away. A complete fresh
   // prefix plus a new matching exposed meld resolves an old extra outline.
   if(!old.complete&&!old.rejected?.length&&next.complete&&old.tiles.every((t,i)=>t.tile===next.tiles[i]?.tile&&t.sideways===next.tiles[i]?.sideways)){
    const called=positions.filter(q=>q!=='self').some(q=>{
     const previous=canonicalMelds(before,q,before.opponent_melds[q]);
     return canonicalMelds(after,q,after.opponent_melds[q]).some(m=>m.from===initialActor&&m.tiles[m.calledIndex]===discardTile&&!previous.some(n=>eq(n,m)));
    });
    if(called)old.complete=true;
   }
  }
  if(!old.complete||!next.complete||old.tiles.some((t,i)=>t.tile!==next.tiles[i]?.tile||t.sideways!==next.tiles[i]?.sideways))throw Error('Incomplete or changed river prefix');
  const added=next.tiles.slice(old.tiles.length);
  if(added.some(t=>typeof t.sideways!=='boolean'))throw Error('Declaration unsupported');
  const calledDeclaration=declaring&&p==='self'&&positions.filter(q=>q!=='self').some(q=>{
   const oldM=canonicalMelds(before,q,before.opponent_melds[q]);
   return canonicalMelds(after,q,after.opponent_melds[q]).some(m=>m.from===own&&m.tiles[m.calledIndex]===discardTile&&!oldM.some(n=>eq(n,m)));
  });
  // If the declaration was called, the next visible own discard can carry
  // the sideways marker instead. It is still not a second declaration.
  if(p==='self'&&added.some((t,i)=>t.sideways&&(!riichi||i!==0)))throw Error('Unaccounted own declaration');
  for(const t of added.filter(t=>t.sideways&&p!=='self')){
   if(added.filter(n=>n.tile===t.tile).length!==1)throw Error('Ambiguous declaration tile');
   declarations.add(`${seats[p]}:${t.tile}`);
  }
  if(declaring&&p==='self'&&!calledDeclaration&&(added[0]?.tile!==discardTile||added[0]?.sideways!==true))throw Error('Missing visible riichi declaration');
  queues[seats[p]]=added.map(t=>t.tile);
  const oldM=canonicalMelds(before,p,p==='self'?before.own_melds:before.opponent_melds[p]),newM=canonicalMelds(after,p,p==='self'?after.own_melds:after.opponent_melds[p]);
  for(const m of oldM){
   let j=newM.findIndex(n=>eq(m,n));
   if(j<0&&p!=='self'&&m.kind==='PENG'){
    j=newM.findIndex(n=>n.kind==='BUGANG'&&n.from===m.from&&n.calledIndex===m.calledIndex&&n.tiles.length===4&&m.tiles.every(t=>n.tiles.includes(t))&&n.tiles.every(t=>t===m.tiles[0]));
    if(j>=0)calls.push({...newM[j],actor:seats[p],upgrade:true,called:m.tiles[0]});
   }
   if(j<0)throw Error('Old meld changed');newM.splice(j,1);
  }
  for(const m of newM){
   if(p==='self'||!['CHI','PENG','GANG','ANGANG'].includes(m.kind)||(m.kind==='CHI'&&(seats[p]+3)%4!==m.from))throw Error('Unsupported new meld');
   calls.push({...m,actor:seats[p],concealed:m.kind==='ANGANG',called:m.kind==='ANGANG'?m.tiles[0]:m.tiles[m.calledIndex]});
  }
 }
 if(!depositsConsistent(before,after,(declaring?1:0)+declarations.size))throw Error('Declarations disagree with paid deposits');
 if(!calls.length||calls.length>4)throw Error('One to four calls required');
 if(!Number.isInteger(b.remaining.value)){const estimated=estimateWall(after);if(estimated!==null)fillWall(after,estimated,'visible-call-tiles');}
 const draws=a.remaining.value-b.remaining.value;
 if(!Number.isInteger(a.remaining.value)||!Number.isInteger(b.remaining.value)||draws<0||draws>(riichi?70:8))throw Error('Invalid wall delta');
 const solutions=new Map();let visited=0;
 function save(events){
  const checks=checkpoints.filter(f=>Number.isInteger(f.round?.remaining?.value)&&positions.every(p=>f.rivers?.[p]?.complete));
  const rivers=Object.fromEntries(positions.map(p=>[seats[p],before.rivers[p].tiles.map(t=>t.tile)]));if(!publicStart)rivers[own].push(discardTile);
  let wall=a.remaining.value,last=initialActor;const seen=new Set();
  function match(){checks.forEach((f,i)=>{if(wall===f.round.remaining.value&&positions.every(p=>eq(rivers[seats[p]],f.rivers[p].tiles.map(t=>t.tile))))seen.add(i);});}
  match();
  for(const event of events){const t=event.state.split(' ');
   if(t[0]==='2')wall--;
   else if(t[2]==='DRAW')wall--;
   else if(['PLAY','LIZHI'].includes(t[2])){last=Number(t[1]);rivers[last].push(t[3]);}
   else if(['CHI','PENG','GANG'].includes(t[2])){rivers[last].pop();last=Number(t[1]);if(t[2]!=='GANG')rivers[last].push(t.at(-1));}
   match();
  }
  if(seen.size===checks.length)solutions.set(JSON.stringify(events),events);
 }
 const consumed=(q,used)=>used===((1<<calls.length)-1)&&Object.values(q).every(t=>!t.length);
 function nextTurn(actor,q,used,n,events){
  if(++visited>10000)throw Error('Event search limit');
  if(consumed(q,used)&&n===draws&&!nextDraw){save(events);return;}
  if(consumed(q,used)&&nextDraw&&n+1===draws&&(actor+1)%4===own){const result=[...events,{state:`2 ${nextDraw}`,validact:'PLAY'}];save(result);return;}
  if(consumed(q,used)&&!nextDraw&&n+1===draws&&(actor+1)%4!==own&&
     (b.turn?.position==null||seats[b.turn.position]===(actor+1)%4)&&!after.controls?.PASS){
   save([...events,{state:`3 ${(actor+1)%4} DRAW`,validact:null}]);return;
  }
  const turn=(actor+1)%4;
  const alreadyDrawn=publicStart?.committedDraw===turn&&events.length===0&&used===0&&n===0;
  if((n>=draws&&!alreadyDrawn)||solutions.size>1)return;
  if(turn===own){
   if(!riichi)return;
   for(const tile of candidates(turn,q,used))discard(turn,tile,q,used,n+1,[...events,{state:`2 ${tile}`,validact:null},{state:`3 ${turn} PLAY ${tile}`,validact:null}]);
   return;
  }
  const prefix=alreadyDrawn?[...events]:[...events,{state:`3 ${turn} DRAW`,validact:null}];
  afterDraw(turn,q,used,n+(alreadyDrawn?0:1),prefix);
 }
 function afterDraw(turn,q,used,n,prefix){
  if(consumed(q,used)&&n===draws&&!nextDraw){save(prefix);return;}
  for(let j=0;j<calls.length;j++){
   const m=calls[j];if((!m.upgrade&&!m.concealed)||m.actor!==turn||(used&(1<<j)))continue;
   const mask=used|(1<<j),kong=[...prefix,{state:`3 ${turn} ${m.concealed?'ANGANG':'BUGANG'} ${m.called}`,validact:null}];
   if(consumed(q,mask)&&n===draws&&!nextDraw)save(kong);
   if(n<draws)afterDraw(turn,q,mask,n+1,[...kong,{state:`3 ${turn} DRAW`,validact:null}]);
  }
  for(const tile of candidates(turn,q,used))discard(turn,tile,q,used,n,[...prefix,{state:`3 ${turn} ${declarations.has(`${turn}:${tile}`)?'LIZHI':'PLAY'} ${tile}`,validact:null}]);
 }
 function candidates(actor,q,used){return [...new Set([q[actor][0],...calls.filter((m,j)=>!m.upgrade&&!(used&(1<<j))&&m.from===actor).map(m=>m.called)].filter(Boolean))];}
 function discard(actor,tile,q,used,n,events){
  if(q[actor][0]===tile){const copy=structuredClone(q);copy[actor].shift();nextTurn(actor,copy,used,n,events);}
  for(let j=0;j<calls.length;j++){
   const m=calls[j];if(m.upgrade||(used&(1<<j))||m.from!==actor||m.called!==tile)continue;
   const position=positions.find(p=>seats[p]===m.actor);
   if(checkpoints.some(frame=>{
    const entry=frame.opponent_melds?.[position],wall=frame.round?.remaining?.value;
    if(!entry?.complete||!Number.isInteger(wall)||wall<a.remaining.value-draws||wall>a.remaining.value)return false;
    const present=canonicalMelds(frame,position,entry).some(x=>x.kind===m.kind&&x.from===m.from&&x.calledIndex===m.calledIndex&&eq(x.tiles,m.tiles));
    const elapsed=a.remaining.value-wall;
    return present?n>elapsed:n<elapsed;
   }))continue;
   const consumed=m.tiles.filter((_,k)=>k!==m.calledIndex),mask=used|(1<<j);
   if(m.kind==='GANG'){
    // An open kong takes the source discard but has no bundled discard.
    // Its replacement draw belongs to the caller, not the next seat.
    const kong=[...events,{state:`3 ${m.actor} GANG ${tile}`,validact:null}];
    if((mask===((1<<calls.length)-1)&&Object.values(q).every(t=>!t.length))&&n===draws&&!nextDraw)save(kong);
    if(n<draws){
     const drawn=[...kong,{state:`3 ${m.actor} DRAW`,validact:null}];
     if((mask===((1<<calls.length)-1)&&Object.values(q).every(t=>!t.length))&&n+1===draws&&!nextDraw)save(drawn);
     afterDraw(m.actor,q,mask,n+1,drawn);
    }
   }else{
    for(const out of candidates(m.actor,q,mask))discard(m.actor,out,q,mask,n,[...events,{state:`3 ${m.actor} ${m.kind} ${tile} ${consumed.join(' ')} ${out}`,validact:null}]);
   }
  }
 }
 if(publicStart?.phase==='draw'){
  afterDraw(initialActor,queues,0,0,[]);
 }else discard(initialActor,discardTile,queues,0,0,[]);
 if(!solutions.size){const error=Error(`Chained call ordering absent (0 solutions, ${visited} states)`);error.candidates=[];throw error;}
 const estimated=solutions.size>1;
 return {verified:true,estimated,assumptions:estimated?['历史动作顺序存在多个可行解，采用首个符合可见牌河、副露及摸牌数的顺序']:[],requests:[...solutions.values()][0].map(q=>estimated?{...q,historyOrderCertain:false}:q),nextDraw,confirmation:{action:decision.output.response,gameConfirmed:true,nextDraw,before:before.id,after:after.id},before:before.id,after:after.id,scope:estimated?'estimated order; visible river/meld differences; exact draw count; accounted own hand':'unique visible river/meld differences; exact draw count; accounted own hand'};
}
