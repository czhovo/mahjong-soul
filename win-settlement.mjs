// Confirm a sent HU from visible settlement amounts, never from an AHK ACK.
// Context scores are hand-opening balances; accepted historical riichi is
// subtracted exactly once, as in the frozen bot's input contract.
export function verifyWinSettlement(decision,before,frame){
 if(decision?.output?.response!=='HU'||!frame?.id||frame.id===before?.id||
    !frame.settlement?.complete)throw Error('Fresh complete win settlement required');
 const input=decision.input,context=input?.match_context;
 const seats=before?.round?.seat_identity;
 if(!seats?.verified)throw Error('Verified pre-win seat mapping required');
 const positions=['self','right','opposite','left'];
 if(positions.map(p=>seats.seats[p]).sort().join(',')!=='0,1,2,3')throw Error('Invalid seats');
 const scores=Array(4),opening=context?.scores;
 for(const p of positions)scores[seats.seats[p]]=frame.settlement.scores[p]?.value;
 if(!Array.isArray(opening)||opening.length!==4||[...scores,...opening].some(x=>!Number.isInteger(x)||x%100))throw Error('Exact scores required');
 if(!Number.isInteger(context.riichi_sticks)||context.riichi_sticks<0)throw Error('Exact deposits required');
 const bank=opening.reduce((a,b)=>a+b,0)+1000*context.riichi_sticks;
 if(scores.reduce((a,b)=>a+b,0)!==bank)throw Error('Win settlement conservation failed');
 const event=input.requests.at(-1)?.state??'';
 const self=seats.seats.self,ron=event.match(/^3 ([0-3]) (PLAY|LIZHI|CHI|PENG|BUGANG) /);
 const tsumo=/^2 [WBTZ][0-9]$/.test(event);
 if(!tsumo&&(!ron||Number(ron[1])===self))throw Error('Unverified win source');
 const balances=[...opening],declared=new Set();
 // Last-event ron on a declaration tile occurs before its deposit is paid.
 for(const request of input.requests.slice(0,-1)){
  const m=request.state?.match(/^3 ([0-3]) LIZHI /);
  if(m){const seat=Number(m[1]);if(declared.has(seat))throw Error('Duplicate declaration');declared.add(seat);balances[seat]-=1000;}
 }
 const delta=scores.map((x,i)=>x-balances[i]);
 if(delta[self]<=0)throw Error('Own win not supported by settlement');
 if(tsumo){if(delta.some((x,i)=>i!==self&&x>=0))throw Error('Self draw payers not confirmed');}
 else if(delta.some((x,i)=>i!==self&&(i===Number(ron[1])?x>=0:x!==0)))throw Error('Ron payer not confirmed');
 return {verified:true,confirmedOwnAction:'HU',observationId:frame.id,source:'visible-settlement',
  scores,riichiSticks:0,seats:seats.seats,winType:tsumo?'tsumo':'ron',delta};
}
