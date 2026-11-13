import {GAME,remainingHands} from './game-rules.mjs';
const positions=GAME.positions;

// Retain OCR evidence and identify the one value inferred by conservation.
export function completeMissingScore(reading,sticks,bank=GAME.bank){
 if(!reading?.scores||!Number.isInteger(sticks)||sticks<0||!Number.isInteger(bank)||bank%100)return reading;
 const missing=positions.filter(p=>!Number.isInteger(reading.scores[p]?.value));
 if(missing.length!==1)return reading;
 const known=positions.filter(p=>p!==missing[0]).map(p=>reading.scores[p].value);
 if(known.some(v=>v%100))return reading;
 const position=missing[0],value=bank-1000*sticks-known.reduce((a,b)=>a+b,0);
 return {...reading,complete:true,scores:{...reading.scores,[position]:{
  ...reading.scores[position],value,inferred:true,inference:'point-conservation',
  recognizedValue:reading.scores[position]?.value??null,
 }},inference:{position,value,bank,riichiSticks:sticks}};
}

export function completeFrameScores(frame,bank=GAME.bank){
 const sticks=frame.round?.counters?.riichi_sticks;
 for(const field of ['settlement','table_scores']){
  if(frame[field])frame[field]=completeMissingScore(frame[field],sticks,bank);
 }
 return frame;
}
