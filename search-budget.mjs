export class SearchBudget {
 constructor(){this.seconds=3.3;this.hand=null;this.messages=[];}
 beginHand(identity,timer){
  this.postMatch=false;
  if(identity){
   const key=JSON.stringify(identity);
   if(this.hand!==null&&key!==this.hand){
    if(this.seconds===1.7)this.messages.push('已恢复搜索预算至3.3秒');
    this.seconds=3.3;
   }
   this.hand=key;
  }
  this.observe(timer);
 }
 observeFrame(frame,{phase}={}){
  if(phase==='post_match'||frame.terminal_phase?.name==='match_end'||frame.result_page?.kind==='match-result')this.postMatch=true;
  if(this.postMatch||frame.result_page||frame.settlement?.complete||!frame.hand?.complete)return;
  this.observe(frame.time_reserve);
 }
 observe(timer){
  if(this.seconds===1.7||!timer?.verified||!Number.isInteger(timer.reserve_seconds)||timer.reserve_seconds<0||timer.reserve_seconds>5)return;
  this.seconds=1.7;
  this.messages.push('已降低搜索预算至1.7秒');
 }
 drain(){return this.messages.splice(0);}
}
