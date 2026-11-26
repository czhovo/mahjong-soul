import {GAME} from './game-rules.mjs';
export function roundIdentity(frame){
 const r=frame?.round,wind=r?.wind,hand=r?.hand_number?.value,honba=r?.counters?.honba;
 const seats=r?.seat_identity?.seats;
 if(!r?.seat_identity?.verified||!Number.isInteger(wind)||wind<0||wind>3||
    !Number.isInteger(hand)||hand<1||hand>GAME.players||!Number.isInteger(honba)||honba<0||
    GAME.positions.map(p=>seats?.[p]).sort().join(',')!==GAME.seats.join(','))return null;
 return {wind,hand,honba,seats:Object.fromEntries(GAME.positions.map(p=>[p,seats[p]]))};
}
export function roundAdvanced(a,b){
 return a&&b&&(b.wind>a.wind||b.wind===a.wind&&(b.hand>a.hand||b.hand===a.hand&&b.honba>a.honba));
}
function nextHand(a,b){
 if(GAME.sanma)return roundAdvanced(a,b);
 const repeat=b.wind===a.wind&&b.hand===a.hand&&b.honba===a.honba+1;
 const rotate=b.hand===a.hand%4+1&&b.wind===a.wind+(a.hand===4?1:0)&&
   (b.honba===0||b.honba===a.honba+1);
 return (repeat||rotate)&&GAME.positions.every(p=>b.seats[p]===(a.seats[p]+(rotate?3:0))%4);
}
export function conflictingRound(before,after){
 const a=roundIdentity(before),b=roundIdentity(after);
 return a&&b&&JSON.stringify(a)!==JSON.stringify(b)&&!nextHand(a,b);
}
export const conflictingSanmaRound=(a,b)=>GAME.sanma&&conflictingRound(a,b);
export function changedRound(before,after){
 const a=roundIdentity(before),b=roundIdentity(after);
 return a&&b&&nextHand(a,b)?{before:a,after:b}:null;
}
