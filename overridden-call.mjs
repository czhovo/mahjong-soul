import {GAME,remainingHands} from './game-rules.mjs';
import {canonicalMelds} from './meld-events.mjs';
const norm=t=>t?.replace(/^([WBT])0$/,(_,s)=>s+'5');
const key=m=>JSON.stringify([m.kind,m.from,m.calledIndex,[...m.tiles].sort()]);

// A ron on the pending source discard has exactly that payer, and one or
// more other winners. Do not call a draw, tsumo or unreadable score a ron.
export function callOverriddenByRon(pending,frame){
 const decision=pending?.decision,[kind,tile]=(decision?.output?.response??'').split(' ');
 if(!['CHI','PENG','GANG'].includes(kind)||pending.discardDecision||!frame.settlement?.complete)return null;
 const q=decision.input?.requests?.at(-1)?.state?.split(' ')??[];
 const trigger=['PLAY','LIZHI'].includes(q[2])?q[3]:['CHI','PENG'].includes(q[2])&&q.length===7?q[6]:null;
 if(q[0]!=='3'||norm(trigger)!==norm(tile))return null;
 const context=decision.input.match_context,seats=pending.before.round?.seat_identity?.seats;
 if(!seats||!context||context.estimated||!context.scores?.every(Number.isFinite))return null;
 // Deduct already-paid historical riichi deposits (excluding the last trigger event if it was a LIZHI)
 // so a non-payer who previously declared riichi is not mistaken for a loser.
 const balances=[...context.scores],declared=new Set();
 for(const request of (decision.input.requests??[]).slice(0,-1)){
  const m=request.state?.match(/^3 ([0-3]) LIZHI /);
  if(m){const s=Number(m[1]);if(!declared.has(s)&&s<balances.length){declared.add(s);balances[s]-=1000;}}
 }
 const delta=Array(GAME.players);
 for(const p of GAME.positions){
  const s=seats[p];
  const value=frame.settlement.scores?.[p]?.value;
  if(!Number.isInteger(s)||!Number.isFinite(value))return null;
  delta[s]=value-balances[s];
 }
 const source=Number(q[1]),winners=delta.map((v,s)=>v>0?s:null).filter(s=>s!==null);
 if(delta[source]>=0||delta[seats.self]!==0||!winners.length||winners.includes(source)||delta.some((v,s)=>s!==source&&v<0))return null;
 return {kind:'HU',winType:'ron',seats:winners,tile};
}

// A newly verified opponent meld must claim the very discard we reacted to.
export function overriddenCall(decision,before,after){
 const [action,tile]=decision.output.response.split(' ');
 if(!['CHI','PENG'].includes(action))return null;
 const words=decision.input?.requests?.at(-1)?.state?.split(' ')??[];
 if(words[0]!=='3')return null;
 const trigger=['PLAY','LIZHI'].includes(words[2])?words[3]:
  ['CHI','PENG'].includes(words[2])&&words.length===7?words[6]:null;
 if(norm(trigger)!==norm(tile))return null;
 for(const position of GAME.opponents){
  try{
   const old=canonicalMelds(before,position,before.opponent_melds?.[position]);
   const next=canonicalMelds(after,position,after.opponent_melds?.[position]);
   const rest=[...next];
   let intact=true;
   for(const m of old){const i=rest.findIndex(n=>key(n)===key(m));if(i<0){intact=false;break;}rest.splice(i,1);}
   if(!intact||rest.length!==1)continue;
   const meld=rest[0];
   if(['PENG','GANG'].includes(meld.kind)&&meld.from===Number(words[1])&&norm(meld.tiles[meld.calledIndex])===norm(tile))
    return {seat:after.round.seat_identity.seats[position],kind:meld.kind,tile};
  }catch{}
 }
 return null;
}
