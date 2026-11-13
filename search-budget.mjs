const LONG=5.5,SHORT=3.5;
export class SearchBudget {
 constructor(lowProfile=false){this.normal=lowProfile?2.2:LONG;this.reduced=lowProfile?2.2:SHORT;this.seconds=this.normal;this.inSearch=false;this.lowSeen=false;this.hand=null;this.messages=[];}
 static forEngine(engine){
  const b=new SearchBudget();
  b.seconds=b.normal=engine.searchSeconds;b.reduced=engine.reducedSearchSeconds??b.normal;
  return b;
 }
 beginHand(identity,timer){
  this.postMatch=false;
  if(identity){
   const key=JSON.stringify(identity);
   if(this.hand!==null&&key!==this.hand){
    if(this.normal!==this.reduced&&this.seconds===this.reduced)this.messages.push(`已恢复搜索预算至${this.normal}秒`);
    this.lowSeen=false;this.seconds=this.normal;
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
  if(this.seconds===this.reduced||!timer?.verified||!Number.isInteger(timer.reserve_seconds)||timer.reserve_seconds<0||timer.reserve_seconds>5)return;
  if(this.inSearch){this.lowSeen=true;return;}
  this.applyLow();
 }
 beginSearch(){this.inSearch=true;}
 endSearch(){
  this.inSearch=false;
  if(this.lowSeen){this.lowSeen=false;this.applyLow();
   if(this.report)for(const line of this.drain())this.report(line);
  }
 }
 applyLow(){
  if(this.seconds===this.reduced)return;
  this.seconds=this.reduced;
  this.messages.push(`已降低搜索预算至${this.reduced}秒`);
 }
 drain(){return this.messages.splice(0);}
}

// A running engine keeps the executable selected at request start. Only the
// budget for future launches changes; the monitor never touches that process.
export async function captureWithDecisionTimer(capture,budget,searching,report){
 const hand=budget.hand,watch=!!searching&&!budget.lowSeen&&budget.seconds!==budget.reduced&&!budget.postMatch;
 const frame=await capture.capture(true,watch);
 if(watch&&budget.hand===hand&&!budget.postMatch&&frame.captureEvidence?.timeReserve?.verified){
  budget.observe(frame.captureEvidence.timeReserve);
  for(const message of budget.drain())report(message);
 }
 return frame;
}
