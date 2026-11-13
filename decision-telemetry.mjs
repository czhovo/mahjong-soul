import {searchSummary as existingSearchSummary} from './sanma-search-summary.mjs';
// Preserve the engine's own termination reason and node count.
export function parseDecisionTelemetry(stderr,response){
 let result=null;
 for(const line of stderr.split(/\r?\n/)){
  try{const item=JSON.parse(line);if(item.type==='decision_telemetry'&&item.response===response)result=item;}catch{}
 }
 return result;
}
function layerCount(t,kind,count){
 let n=count.completed;
 if(Number.isInteger(n)&&n<count.target){
  const rows=t.parallel?.layers;
  const p=Array.isArray(rows)?rows.map(l=>l?.['shared_'+kind+'_policy']).findLast(p=>p?.['target_'+kind+'_depth']===n+1):null;
  let done=0,total=0;
  if(kind==='progress'&&Array.isArray(p?.required_units)&&Array.isArray(p.coverage_units)){
   const required=new Set(p.required_units);
   total=required.size;done=[...new Set(p.coverage_units)].filter(x=>required.has(x)).length;
  }else if(kind==='shape'&&[p?.required_draw_mask,p?.coverage_mask].every(x=>Number.isSafeInteger(x)&&x>=0)){
   const bits=x=>x.toString(2).replaceAll('0','').length;
   const required=BigInt(p.required_draw_mask);
   total=bits(required);done=bits(BigInt(p.coverage_mask)&required);
  }
  if(total)n+=done/total;
 }
 return Number.isInteger(n)?String(n):n.toFixed(2);
}
export function searchSummary(t,response){
 if(process.env.MAJSOUL_CONTROLLER_GAME==='sanma'||/^tingyuan-/.test(t?.version??''))return existingSearchSummary(t,response);
 let reason='其他';
 if(t){
  const r=t.exit_reason;
  if(r==='completed_search')reason='搜索完成';
  else if(r==='time_limit'||r==='deadline_fallback'||t.stop_flags?.time_limit)reason='时间用尽';
  else if(['memory_limit','out_of_memory','memory_exhausted'].includes(r)||/bad_alloc|out of memory/i.test([t.exception,t.parallel_error].filter(Boolean).join(' ')))reason='内存用尽';
  else if(r==='kita_wins_joint_candidate_comparison'&&t.search_executed===true)reason='搜索完成';
  else if(t.search_executed===false&&response?.trim()==='PASS')reason='PASS';
 }
 const counts=[t?.layer_completion?.progress,t?.layer_completion?.shape];
 const valid=counts.every(x=>x&&Number.isFinite(x.completed)&&Number.isSafeInteger(x.target)&&x.completed>=0&&x.completed<=x.target);
 const layers=valid?`，${layerCount(t,'progress',counts[0])}/${counts[0].target}，${layerCount(t,'shape',counts[1])}/${counts[1].target}`:'';
 return `（${reason} ${Number.isSafeInteger(t?.nodes)&&t.nodes>=0?t.nodes:'未知'}${layers}）`;
}
