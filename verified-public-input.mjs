import {canonicalMelds} from './meld-events.mjs';
const norm=t=>t?.replace(/^([WBT])0$/,(_,s)=>s+'5');
// Insert a visually verified open kong at its source discard, not at the
// later decision. This preserves the caller/source relationship in the engine.
export function missingOpenKongs(requests,frame){
 const additions=[];
 for(const position of ['right','opposite','left']){
  let melds;try{melds=canonicalMelds(frame,position,frame.opponent_melds?.[position]);}catch{continue;}
  const actor=frame.round.seat_identity.seats[position];
  for(const m of melds.filter(m=>m.kind==='GANG')){
   const tile=m.tiles[m.calledIndex];
   if(requests.some(r=>{const w=r.state?.split(' ')??[];return w[0]==='3'&&Number(w[1])===actor&&['GANG','BUGANG'].includes(w[2])&&norm(w[3])===norm(tile);}))continue;
   const source=requests.findLastIndex(r=>{const w=r.state?.split(' ')??[];return w[0]==='3'&&Number(w[1])===m.from&&(['PLAY','LIZHI'].includes(w[2])?norm(w[3])===norm(tile):['CHI','PENG'].includes(w[2])&&w.length===7&&norm(w[6])===norm(tile));});
   if(source<0)continue;
   // An existing pung would mean an upgrade, not an unrecorded open kong.
   if(requests.slice(0,source+1).some(r=>r.state?.startsWith(`3 ${actor} PENG ${tile} `)))continue;
   const events=[{state:`3 ${actor} GANG ${tile}`,validact:null,source:'verified-visible-open-kong',frameId:frame.id}];
   if(requests[source+1]?.state!==`3 ${actor} DRAW`)events.push({state:`3 ${actor} DRAW`,validact:null,source:'verified-open-kong-replacement-draw',frameId:frame.id});
   additions.push({index:source+1,events});
  }
 }
 return additions.sort((a,b)=>b.index-a.index);
}
export function currentIndicators(requests,frame,previous=[]){
 let known=[...previous];
 for(const r of requests){const ts=r.doraIndicators?.trim().split(/\s+/);if(ts?.length>known.length)known=ts;}
 const d=frame?.dora,ts=d?.tiles?.map(t=>t.tile);
 if(d?.complete&&!d.rejected?.length&&ts?.length&&ts.every(t=>/^(?:[WBT][0-9]|Z[1-7])$/.test(t))&&ts.length>=known.length)known=ts;
 return known;
}
