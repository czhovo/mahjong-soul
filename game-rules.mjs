// Shared controller rules. Only the separate tingyuan entry sets this mode;
// the existing tingfeng entry retains its four-player defaults.
import {fileURLToPath} from 'node:url';
const sanma=process.env.MAJSOUL_CONTROLLER_GAME==='sanma';
export const GAME=Object.freeze({
 sanma,players:sanma?3:4,runtimeRoot:sanma?fileURLToPath(new URL('./sanma/',import.meta.url)):null,
 positions:Object.freeze(sanma?['self','right','left']:['self','right','opposite','left']),
 opponents:Object.freeze(sanma?['right','left']:['right','opposite','left']),
 seats:Object.freeze(sanma?[0,1,2]:[0,1,2,3]),
 initialScores:Object.freeze(sanma?[35000,35000,35000]:[25000,25000,25000,25000]),
 bank:sanma?105000:100000,initialWall:sanma?55:70,
 returnPoints:sanma?35000:25000,endPoints:sanma?40000:30000,
 placement:Object.freeze(sanma?[15000,0,-15000]:[15000,5000,-5000,-15000]),
 scheduledWinds:sanma?(process.env.TINGYUAN_SCHEDULED_WINDS==='1'?1:2):1,
 relativeOffset:Object.freeze(sanma?{left:2,right:1}:{left:3,opposite:2,right:1}),
});
// Legacy wait records without a candidate list referred to an upstream discard.
export function waitPositions(event){
 const source=event.round?.seats&&Object.keys(event.round.seats).find(p=>event.round.seats[p]===event.discard?.seat);
 return (event.candidate_positions??['left','opposite','right'].filter(p=>p!==(source??'left'))).filter(p=>GAME.opponents.includes(p));
}
export const remainingHands=(wind,hand)=>Math.max(1,GAME.players*(GAME.scheduledWinds-wind)-hand+1);
