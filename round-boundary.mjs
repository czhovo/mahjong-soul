import {GAME,remainingHands} from './game-rules.mjs';
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
export function conflictingSanmaRound(before,after){
 if(!GAME.sanma)return false;
 const a=roundIdentity(before),b=roundIdentity(after);
 return a&&b&&JSON.stringify(a)!==JSON.stringify(b)&&!roundAdvanced(a,b);
}
export function changedRound(before,after){
 const a=roundIdentity(before),b=roundIdentity(after);
 return a&&b&&(GAME.sanma?roundAdvanced(a,b):JSON.stringify(a)!==JSON.stringify(b))?{before:a,after:b}:null;
}
