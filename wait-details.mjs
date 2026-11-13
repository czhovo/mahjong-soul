import {GAME,remainingHands} from './game-rules.mjs';
import {shapeWaits} from './tenpai-hint.mjs';
const codes=[...['W','B','T'].flatMap(s=>Array.from({length:9},(_,i)=>s+(i+1))),...Array.from({length:7},(_,i)=>'Z'+(i+1))];
const norm=t=>t?.endsWith('0')?t[0]+'5':t;
const idx=t=>codes.indexOf(norm(typeof t==='string'?t:t?.tile));
const edge=i=>i>=27||i%9===0||i%9===8;
export function waitHistory(session){
 const h={discards:[],riichi:false,temporary:false,riichiPass:false,complete:!!session&&!session.estimatedHistory,handIndex:session?.context?.hand_index,honba:session?.context?.honba};
 if(!session)return h;
 const requests=session.pending?.input?.requests??session.requests??[];
 const init=requests.find(r=>/^0 [0-3] [0-3]$/.test(r.state??''))?.state.split(' ');
 if(init){h.seat=Number(init[1]);h.wind=Number(init[2]);}
 const responses=session.pending?[...session.pending.input.responses,session.pending.output.response]:session.responses??[];
 for(let i=0;i<requests.length;i++){
  const w=(requests[i].state??'').split(/\s+/);
  if(w[0]==='2')h.temporary=false;
  if(w[0]==='3'&&Number(w[1])===session.seat){
   if(w[2]==='LIZHI')h.riichi=true;
   if(['PLAY','LIZHI'].includes(w[2]))h.discards.push(w[3]);
   if(['CHI','PENG'].includes(w[2]))h.discards.push(w[6]);
  }
  if(/(?:^|,)RONG(?:,|$)/.test(requests[i].validact??'')&&responses[i]&&responses[i]!=='HU'){
   h.temporary=true;if(h.riichi)h.riichiPass=true;
  }
 }
 return h;
}
function partitions(c,groups=[]){
 const i=c.findIndex(n=>n);if(i<0)return [groups];let out=[];
 if(c[i]>=3){c[i]-=3;out.push(...partitions(c,[...groups,{t:i,trip:true,open:false}]));c[i]+=3;}
 if(i<27&&i%9<7&&c[i+1]&&c[i+2]){c[i]--;c[i+1]--;c[i+2]--;out.push(...partitions(c,[...groups,{t:i,trip:false,open:false}]));c[i]++;c[i+1]++;c[i+2]++;}
 return out;
}
// Enumerate decompositions and winning-tile placement separately for ron/tsumo.
// Event-dependent yaku are supplied only when actually known, never predicted.
export function waitYaku(hand,melds,win,{seat,wind,riichi=false}={}){
 const c=Array(34).fill(0);for(const t of [...hand,win])c[idx(t)]++;
 const all=[...hand,...melds.flatMap(m=>m.tiles),win].map(idx),w=idx(win);
 const closed=melds.every(m=>m.kind==='ANGANG');
 const fixed=melds.map(m=>({t:Math.min(...m.tiles.map(idx)),trip:m.kind!=='CHI',open:m.kind!=='ANGANG',kong:m.tiles.length===4}));
 const suits=new Set(all.filter(i=>i<27).map(i=>Math.floor(i/9))),honors=all.some(i=>i>=27);
 const base=[];
 if(riichi&&closed)base.push('立直');
 if(all.every(i=>!edge(i)))base.push('断幺九');
 if(suits.size===1)base.push(honors?'混一色':'清一色');
 if(all.every(edge)&&honors&&suits.size)base.push('混老头');
 const universal=[];
 if(all.every(i=>i>=27))universal.push('字一色');
 if(all.every(i=>i<27&&edge(i)))universal.push('清老头');
 if(all.every(i=>[19,20,21,23,25,32].includes(i)))universal.push('绿一色');
 if(closed&&!melds.length&&suits.size===1&&!honors){const s=Math.floor(all[0]/9)*9;if(c[s]>=3&&c[s+8]>=3&&Array.from({length:7},(_,i)=>c[s+i+1]).every(n=>n>=1))universal.push('九莲宝灯');}
 const results={ron:[],tsumo:[]};
 const add=(mode,y)=>{const names=[...new Set(y)].sort();if(names.length&&!results[mode].some(a=>a.join('|')===names.join('|')))results[mode].push(names);};
 if(!melds.length){
  const orphan=[0,8,9,17,18,26,27,28,29,30,31,32,33];
  if(orphan.every(i=>c[i])&&orphan.some(i=>c[i]===2)){add('ron',['国士无双']);add('tsumo',['国士无双']);}
  if(c.filter(n=>n===2).length===7)for(const mode of ['ron','tsumo'])add(mode,universal.length?universal:[...base,'七对子',...(mode==='tsumo'?['门前清自摸和']:[])]);
 }
 for(let pair=0;pair<34;pair++)if(c[pair]>=2){
  c[pair]-=2;const sets=partitions(c);c[pair]+=2;
  for(const concealed of sets){
   const gs=[...fixed,...concealed];
   const placements=[...(pair===w?[-1]:[]),...concealed.flatMap((g,k)=>(g.trip?g.t===w:w>=g.t&&w<=g.t+2)?[fixed.length+k]:[])];
   for(const pos of placements)for(const mode of ['ron','tsumo']){
    const y=[...base],yakuman=[...universal],trips=gs.filter(g=>g.trip),seq=gs.filter(g=>!g.trip);
    if(closed&&mode==='tsumo')y.push('门前清自摸和');
    for(const g of trips){if(g.t>=31)y.push(['白','发','中'][g.t-31]);if(g.t===27+seat)y.push('自风');if(g.t===27+wind)y.push('场风');}
    const dragons=trips.filter(g=>g.t>=31).length,winds=trips.filter(g=>g.t>=27&&g.t<=30).length;
    if(dragons===3)yakuman.push('大三元');else if(dragons===2&&pair>=31)y.push('小三元');
    if(winds===4)yakuman.push('大四喜');else if(winds===3&&pair>=27&&pair<=30)yakuman.push('小四喜');
    const hidden=gs.filter((g,k)=>g.trip&&!g.open&&!(mode==='ron'&&k===pos)).length;
    if(hidden===4)yakuman.push('四暗刻');else if(hidden===3)y.push('三暗刻');
    const kans=gs.filter(g=>g.kong).length;if(kans===4)yakuman.push('四杠子');else if(kans===3)y.push('三杠子');
    if(trips.length===4)y.push('对对和');
    const counts=new Map();for(const g of seq)counts.set(g.t,(counts.get(g.t)??0)+1);
    if(closed){const pairs=[...counts.values()].reduce((a,n)=>a+Math.floor(n/2),0);if(pairs>=2)y.push('二杯口');else if(pairs)y.push('一杯口');}
    for(let n=0;n<7;n++)if([n,n+9,n+18].every(t=>seq.some(g=>g.t===t))){y.push('三色同顺');break;}
    for(let n=0;n<9;n++)if([n,n+9,n+18].every(t=>trips.some(g=>g.t===t))){y.push('三色同刻');break;}
    for(let s=0;s<27;s+=9)if([s,s+3,s+6].every(t=>seq.some(g=>g.t===t)))y.push('一气通贯');
    if(seq.length&&edge(pair)&&gs.every(g=>g.trip?edge(g.t):g.t%9===0||g.t%9===6))y.push(honors?'混全带幺九':'纯全带幺九');
    const winningGroup=gs[pos],ryanmen=winningGroup&&!winningGroup.trip&&(w===winningGroup.t||w===winningGroup.t+2)&&!(winningGroup.t%9===0&&w===winningGroup.t+2)&&!(winningGroup.t%9===6&&w===winningGroup.t);
    if(closed&&seq.length===4&&pair<31&&pair!==27+seat&&pair!==27+wind&&ryanmen)y.push('平和');
    add(mode,yakuman.length?yakuman:y);
   }
  }
 }
 // A lower-yaku placement cannot be chosen over the same yaku plus a bonus.
 for(const mode of ['ron','tsumo'])results[mode]=results[mode].filter(a=>
  !results[mode].some(b=>b.length>a.length&&a.every(y=>b.includes(y))));
 return results;
}
export function waitDetails(frame,history={}){
 if(!frame.hand?.complete||!frame.own_melds?.complete)return null;
 const r=frame.round,number=r?.hand_number?.value;
 if((Number.isInteger(history.handIndex)&&Number.isInteger(number)&&Number.isInteger(r?.wind)&&history.handIndex!==GAME.players*r.wind+number)||(Number.isInteger(history.honba)&&Number.isInteger(r?.counters?.honba)&&history.honba!==r.counters.honba))history={};
 const hand=frame.hand.tiles.map(t=>t.tile),melds=frame.own_melds.groups,waits=shapeWaits(hand,melds);if(waits===null)return null;
 const rivers=frame.rivers??{},self=history.seat??r?.seat_identity?.seats?.self,wind=history.wind??r?.wind;
 const ownDiscards=[...(history.discards??[]),...(rivers.self?.tiles??[]).map(t=>t.tile)].map(norm);
 const discardFuriten=waits.some(t=>ownDiscards.includes(t));
 const riichi=history.riichi||(rivers.self?.tiles??[]).some(t=>t.sideways);
 const visible=Array(34).fill(0);let complete=!!frame.dora?.complete;
 const count=tiles=>{for(const t of tiles??[]){const i=idx(t);if(i>=0)visible[i]++;else complete=false;}};
 count(frame.hand.tiles);count(melds.flatMap(m=>m.tiles));count(frame.dora?.tiles);
 if(GAME.sanma)for(const p of GAME.positions){const n=frame.kita?.[p]?.count;if(Number.isInteger(n)&&n>=0&&n<=4)visible[idx('Z4')]+=n;else complete=false;}
 for(const p of GAME.positions){complete&&=!!rivers[p]?.complete;count(rivers[p]?.tiles);if(p!=='self'){const m=frame.opponent_melds?.[p];complete&&=!!m?.complete;count(m?.groups?.flatMap(g=>g.tiles));}}
 const constraints=frame.opponent_hand_constraints;
 const held=tile=>{
  if(constraints?.schema!==2||constraints.time_scope!=='current')return 0;
  const r=constraints.round,f=frame.round;
  if(r&&(r.wind!==f?.wind||r.hand!==f?.hand_number?.value||r.honba!==f?.counters?.honba))return 0;
  const clauses=(constraints.constraints??[]).filter(c=>norm(c.tile)===tile&&c.any_of?.length&&c.any_of.every(a=>Number.isInteger(a.seat)&&a.seat>=0&&a.seat<GAME.players&&a.seat!==self&&Number.isInteger(a.minimum_count)&&a.minimum_count>=0&&a.minimum_count<=4));
  if(!clauses.length)return 0;
  const seats=[...new Set(clauses.flatMap(c=>c.any_of.map(a=>a.seat)))];
  let minimum=Infinity;
  const search=(i,counts,total)=>{
   if(total>=minimum||total>Math.max(0,4-visible[idx(tile)]))return;
   if(i===seats.length){if(clauses.every(c=>c.any_of.some(a=>counts[a.seat]>=a.minimum_count)))minimum=total;return;}
   for(let n=0;n<=4;n++)search(i+1,{...counts,[seats[i]]:n},total+n);
  };
  search(0,{},0);return Number.isFinite(minimum)?minimum:0;
 };
 return waits.map(tile=>({tile,...waitYaku(hand,melds,tile,{seat:self,wind,riichi}),remaining:Math.max(0,4-visible[idx(tile)]-held(tile)),countComplete:complete&&visible[idx(tile)]<=4,
  furiten:discardFuriten?'舍牌振听':history.riichiPass?'立直振听':history.temporary?'临时振听':'',windsKnown:Number.isInteger(self)&&Number.isInteger(wind)}));
}
