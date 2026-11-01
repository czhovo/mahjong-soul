export function roundIdentity(frame){
 const r=frame?.round,wind=r?.wind,hand=r?.hand_number?.value,honba=r?.counters?.honba;
 const seats=r?.seat_identity?.seats;
 if(!r?.seat_identity?.verified||!Number.isInteger(wind)||wind<0||wind>3||
    !Number.isInteger(hand)||hand<1||hand>4||!Number.isInteger(honba)||honba<0||
    ['self','right','opposite','left'].map(p=>seats?.[p]).sort().join(',')!=='0,1,2,3')return null;
 return {wind,hand,honba,seats};
}
export function changedRound(before,after){
 const a=roundIdentity(before),b=roundIdentity(after);
 return a&&b&&JSON.stringify(a)!==JSON.stringify(b)?{before:a,after:b}:null;
}
