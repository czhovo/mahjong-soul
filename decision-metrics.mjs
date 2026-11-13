// Consume diagnostics from the same engine invocation that selected the action.
// The score is utility relative to its noten-draw reference, with heuristics;
// it is neither expected raw points nor a margin over the runner-up.
export function decisionMetrics(stderr,response,input){
 const [kind,tile]=response.trim().split(/\s+/);
 const matchesAction=action=>action===response.trim()||(['CHI','PENG'].includes(kind)&&response.trim().split(/\s+/).length===4&&typeof action==='string'&&action.startsWith(response.trim()+' '));
 const metrics={value:null,off:null,pRon:null,pWin:null,basis:'未听流局基准评分'};
 // Modern engines identify the final root action explicitly, after nested
 // kong searches, parallel layers and policy overrides. Use this authoritative
 // row instead of legacy heuristics intended for engines without final traces.
 let retained=null;
 for(const line of stderr.split(/\r?\n/)){
  let q;try{q=JSON.parse(line);}catch{continue;}
  if(q.retention_decision===true&&matchesAction(q.final_action))retained=q;
 }
 if(retained){
  const rows=retained.candidates?.filter(c=>c.selected===true&&matchesAction(c.action))??[];
  if(rows.length===1){
   const row=rows[0];
   metrics.policy=row.policy??null;
   metrics.value=Number.isFinite(row.score)?row.score:null;
   metrics.off=Number.isFinite(row.off)?row.off:null;
   metrics.pWin=probability(row.win);
   metrics.pRon=probability(row.current_p_ron);
  }
  return metrics;
 }
 let off=null,winRow=null;
 let risk=null,final=null,layerWin=null,call=null,kan=null;
 const matches=c=>c.tile===tile&&(typeof c.riichi!=='boolean'||c.riichi===(kind==='LIZHI'));
 const readDiscard=c=>{
  if(Number.isFinite(c.score))final=c.score;
  if(Number.isFinite(c.off))off=c.off;
  if(probability(c.p_ron)!==null)risk=c.p_ron;
  if(probability(c.win)!==null)layerWin=c.win;
 };
 for(const line of stderr.split(/\r?\n/)){
  let q;try{q=JSON.parse(line);}catch{continue;}
  if(q.match_context){risk=null;final=null;off=null;winRow=null;layerWin=null;}
  if(Number.isFinite(q.selected_value)&&Number.isInteger(q.fair_call_choice))call=q;
  if(q.kan===kind&&q.tile===tile&&Number.isFinite(q.value)&&q.candidate_status!=='filtered')kan=q;
  if(q.decision_probabilities==='discard'&&Array.isArray(q.candidates)){
   winRow=q.candidates.find(c=>c.tile===tile&&c.selected===true&&c.riichi===(kind==='LIZHI'))??null;
  }
  if(matches(q)&&Number.isFinite(q.depth)&&probability(q.p_ron)!==null)risk=q.p_ron;
  if(['PLAY','LIZHI'].includes(kind)){
   if(matches(q)&&Number.isFinite(q.score))readDiscard(q);
   if(Array.isArray(q.committed)&&('search_layer_complete' in q||q.adaptive_layer==='discard'||q.parallel_layer==='discard')){
    const c=q.committed.find(matches);if(c)readDiscard(c);
   }
  }
  // These records follow committed depth and optional-upgrade passes.
  if(q.tile===tile&&q.fold_option)final=q.selected?q.fold_score:q.attack_score;
  // A fold override changes offense without emitting the new off field.
  if(q.tile===tile&&q.fold_option&&q.selected&&!q.already_fold)off=null;
 }
 if(call&&['PASS','CHI','PENG'].includes(kind)){
  const c=call.all_candidates?.find(c=>c.index===call.fair_call_choice);
  // Older traces lacked action fields. New traces must match the selected
  // call and its follow-up discard, never a competing candidate's risk.
  if(c?.action&&(c.action!==kind||(kind!=='PASS'&&c.tile!==response.trim().split(/\s+/).at(-1))))return metrics;
  metrics.value=call.selected_value;
  readDiagnostics(metrics,c);
  return metrics;
 }
 if(kan!==null){metrics.value=kan.value;readDiagnostics(metrics,kan);return metrics;}
 if(!['PLAY','LIZHI'].includes(kind))return metrics;
 metrics.pWin=winRow?probability(winRow.win):probability(layerWin);
 metrics.pRon=probability(risk);
 metrics.value=Number.isFinite(final)?final:null;
 metrics.off=Number.isFinite(off)?off:null;
 return metrics;
}
function probability(value){return Number.isFinite(value)&&value>=0&&value<=1?value:null;}
function readDiagnostics(metrics,row){
 if(row?.policy)metrics.policy=row.policy;
 metrics.pWin=probability(row?.win);
 if(Number.isFinite(row?.off)&&(!row.off_status||row.off_status==='evaluated'))metrics.off=row.off;
 if(Number.isFinite(row?.p_ron)&&row.p_ron>=0&&row.p_ron<=1&&
    (!row.p_ron_status||['estimated','proxy'].includes(row.p_ron_status))){
  metrics.pRon=row.p_ron;
  metrics.pRonScope=row.p_ron_scope??null;
  metrics.pRonStatus=row.p_ron_status??null;
 }
}
const yakumanNames={kokushi:'国士无双',kokushi_13:'国士无双十三面',suuankou:'四暗刻',suuankou_tanki:'四暗刻单骑',daisangen:'大三元',shousuushii:'小四喜',daisuushii:'大四喜',tsuuiisou:'字一色',chinroutou:'清老头',ryuuiisou:'绿一色',chuuren:'九莲宝灯',junsei_chuuren:'纯正九莲宝灯',suukantsu:'四杠子'};
export function metricsText(m,telemetry){
 const parts=[];
 if(Number.isFinite(m?.offDelta))parts.push(`预期价值提升：${m.offDelta>=0?'+':''}${m.offDelta.toFixed(1)}`);
 if(m?.policy==='defense')parts.push('防守路线无和牌率估计');
 else if(m?.policy==='nagashi')parts.push('流局满贯路线无和牌率估计');
 else if(Number.isFinite(m?.pWin))parts.push(`和牌率：${(100*m.pWin).toFixed(2)}%`);
 if(Number.isFinite(m?.pRon))parts.push(`放铳率：${(100*m.pRon).toFixed(2)}%`);
 if(telemetry?.selected_yakuman_preference===true&&telemetry.selected_yakuman_names?.length)
  parts.push('役满机会：'+telemetry.selected_yakuman_names.map(name=>yakumanNames[name]??name).join('、'));
 return parts.join('；');
}
