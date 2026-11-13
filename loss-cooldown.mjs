export class LossStreak {
 constructor(){this.reset();}
 reset(){this.count=0;this.counted=false;}
 beginGame(){this.counted=false;}
 observe(result){
  if(this.counted)return this.count>=2;
  this.counted=true;
  this.count=result?.complete&&Number.isFinite(result.ptChange)&&result.ptChange<0?this.count+1:0;
  return this.count>=2;
 }
}
export class LossCooldown {
 constructor(){this.until=null;}
 start(now=performance.now()){this.until=now+600000;}
 remaining(now=performance.now()){return this.until===null?0:Math.max(0,this.until-now);}
 finish(){this.until=null;}
}
