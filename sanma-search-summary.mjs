// Preserve the engine's own termination reason and node count.
export function parseDecisionTelemetry(stderr,response){
 let result=null;
 for(const line of stderr.split(/\r?\n/)){
  try{const item=JSON.parse(line);if(item.type==='decision_telemetry'&&item.response===response)result=item;}catch{}
 }
 return result;
}
function drawMaskCount(mask){
 if(!Number.isSafeInteger(mask)||mask<0||mask>=2**34)return null;
 return mask.toString(2).replaceAll('0','').length;
}
function layerLabel(t,kind,count){
 const {completed,target}=count;
 const plain=`${completed}/${target}`;
 if(completed===target||!Array.isArray(t.parallel?.layers))return plain;
 const layer=t.parallel.layers.findLast(l=>l?.[`shared_${kind}_policy`]?.[`target_${kind}_depth`]===completed+1);
 if(!layer||layer.committed!==false)return plain;
 const m=layer[`shared_${kind}_policy`];
 let done,total;
 if(kind==='progress'){
  if(!Array.isArray(m.required_units)||!Array.isArray(m.coverage_units))return plain;
  const draws=new Set(m.required_units.filter(x=>/^(own|offer):/.test(x)));
  total=draws.size;done=new Set(m.coverage_units.filter(x=>draws.has(x))).size;
 }else{
  total=drawMaskCount(m.required_draw_mask);done=drawMaskCount(m.coverage_mask);
  if(total===null||done===null||(BigInt(m.coverage_mask)&~BigInt(m.required_draw_mask))!==0n)return plain;
 }
 if(!total||!done)return plain;
 // Complete event coverage can precede final reduction. Only the engine
 // increments the integer part when the entire layer commits.
 const hundredths=Math.min(99,Math.round(100*done/total));
 return `${completed}.${String(hundredths).padStart(2,'0')}/${target}`;
}
export function searchSummary(t,response){
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
 const valid=counts.every(x=>x&&Number.isSafeInteger(x.completed)&&Number.isSafeInteger(x.target)&&x.completed>=0&&x.completed<=x.target);
 const layers=valid?`，${layerLabel(t,'progress',counts[0])}，${layerLabel(t,'shape',counts[1])}`:'';
 return `（${reason} ${Number.isSafeInteger(t?.nodes)&&t.nodes>=0?t.nodes:'未知'}节点${layers}）`;
}
