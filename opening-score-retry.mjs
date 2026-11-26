import {snapshotPointContext} from './table-score-settlement.mjs';
export class OpeningScoreRetry {
 constructor(){this.active=false;}
 begin(context){this.active=context?.estimated===true&&['estimated-missing-settlement','estimated-midgame-points'].includes(context.source);}
 decisionFinished(){this.active=false;}
 observe(frame,context,requests=[]){
  if(!this.active)return null;
  try{
   const corrected=snapshotPointContext(frame,{requests},context);
   this.active=false;return corrected;
  }catch{return null;}
 }
}
