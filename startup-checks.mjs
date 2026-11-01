import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {ClientAdapter} from './client-adapter.mjs';
import {TingfengSession} from './bridge.mjs';
import {validateStartupFields} from './startup-recognition-fields.mjs';

const names={recognition:'recognize v4','v64-3p3-history':'v64-3p3-history','v64-1p7-history':'v64-1p7-history',operation:'ahk execute'};
export class StartupChecks {
 constructor(directory,engine){
  this.directory=directory;
  this.requiredStages=['recognition',engine.version??'v64-3p3-history',engine.reducedVersion??'v64-1p7-history','operation'];
  this.report={startedAt:new Date().toISOString(),engine,status:'pending',checks:{}};
 }
 async save(){await mkdir(this.directory,{recursive:true});await writeFile(join(this.directory,'startup-check.json'),JSON.stringify(this.report,null,2),'utf8');}
 async run(stage,check){
  const started=performance.now();
  this.report.checks[stage]={status:'running'};await this.save();
  try{
   const evidence=await check();
   this.report.checks[stage]={status:'passed',elapsedMs:Math.round(performance.now()-started),evidence};
   this.report.status=this.requiredStages.every(k=>this.report.checks[k]?.status==='passed')?'passed':'pending';
   await this.save();return evidence;
  }catch(cause){
   this.report.status='failed';
   this.report.checks[stage]={status:'failed',elapsedMs:Math.round(performance.now()-started),error:cause.message};
   await this.save();
   throw Object.assign(new Error(`${names[stage]??stage}: Failed — ${cause.message}`,{cause}),{code:'STARTUP_CHECK_FAILED',stage});
  }
 }
}

export function validateRecognition(frame,expected){
 const tiles=region=>region?.tiles?.map(t=>t.tile).join(' ');
 for(const [name,region,value] of [['手牌',frame.hand,expected.hand],['宝牌指示牌',frame.dora,expected.dora],['本方牌河',frame.rivers?.self,expected.selfRiver]]){
  if(!region?.complete||tiles(region)!==value)throw Error(`${name}样本不匹配：预期 ${value}；实际 ${tiles(region)??'缺失'}`);
 }
 for(const [seat,count] of Object.entries(expected.riverCounts)){
  const river=frame.rivers?.[seat];
  if(!river?.complete||river.tiles?.length!==count)throw Error(`${seat} 牌河样本不完整或数量不符`);
 }
 if(!frame.own_melds?.complete||frame.own_melds.groups.length!==0)throw Error('本方副露样本不匹配');
 return {hand:tiles(frame.hand),dora:tiles(frame.dora),selfRiver:tiles(frame.rivers.self),riverCounts:expected.riverCounts};
}

export async function checkRecognition({python,pythonPackages,makeAdapter=(...args)=>new ClientAdapter(...args)}={}){
 const fixture=new URL('./startup-fixtures/recognition.png',import.meta.url);
 const [png,label]=await Promise.all([readFile(fixture),readFile(new URL('./startup-fixtures/recognition.json',import.meta.url),'utf8')]);
 if(png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('识别自检图片损坏');
 const window={id:0,title:'startup-fixture'};
 const adapter=makeAdapter({get_window_state:async()=>({window,screenshots:[{id:'startup-fixture',path:fileURLToPath(fixture),width:png.readUInt32BE(16),height:png.readUInt32BE(20)}]})},window,{python,pythonPackages,recognitionTimeoutMs:null,initializationTimeoutMs:null});
 try{
  const expected=JSON.parse(label),checked={};
  const frame=await adapter.inspect({phase:'auto',meld_count:0,auto_meld_count:true,readTableScores:true,observeSettlement:true,persistEvidence:false});
  const base=validateRecognition(frame,expected);
  checked.full=validateStartupFields(frame,expected.confirmedFields.full,'full');
  const probe=await adapter.inspect({phase:'probe',persistEvidence:false});
  checked.probe=validateStartupFields(probe,expected.confirmedFields.probe,'probe');
  const selection=await adapter.inspect({phase:'auto',meld_count:0,selection:'riichi',persistEvidence:false});
  checked.riichi=validateStartupFields(selection,expected.confirmedFields.riichi,'riichi');
  return {fixture:fileURLToPath(fixture),...base,checked,recognitionMs:frame.timing.recognitionMs};
 }finally{
  // close() terminates and clears the isolated fixture worker.
  await adapter.close();
 }
}

export async function checkDecision({engine,directory,signal,searchSeconds,onProgress=()=>{},makeSession=(exe,path)=>new TingfengSession(exe,path)}){
 if(!engine.reducedExecutable)throw Error('启动预热缺少1.7秒版本');
 const results=[];
 for(const [seconds,executable] of [[3.3,engine.executable],[1.7,engine.reducedExecutable]].filter(([seconds])=>searchSeconds===undefined||seconds===searchSeconds)){
 await onProgress(`${seconds===3.3?engine.version:engine.reducedVersion}: Checking`);
 const session=makeSession(executable,join(directory,`startup-decision-${seconds}`));
 session.searchBudget={seconds};
 session.verifiedBudgetEngine={...engine,executable,reducedExecutable:engine.reducedExecutable};
 const hand='W4 W4 B3 B5 B6 B7 T2 T4 T4 T6 T6 T9 Z6'.split(' ');
 session.begin({seat:3,round:0,hand,indicator:'Z1',context:{schema:1,scores:[25000,25000,25000,25000],hand_index:1,honba:0,riichi_sticks:0,remaining_scheduled_hands:4,is_last_scheduled_hand:false,tie_priority:[0,1,2,3],source:'startup-self-test',point_source:'fixture'}});
 for(const [seat,tile] of [[0,'T1'],[1,'Z4'],[2,'T1']]){
  session.observe({state:`3 ${seat} DRAW`,validact:null});
  session.observe({state:`3 ${seat} PLAY ${tile}`,validact:null});
 }
 // This deadline only belongs to the isolated startup probe. Gameplay has no
 // external decision timeout and retains the verified engine's search budget.
 const deadline=AbortSignal.timeout(15000);
 const decision=await session.decide({state:'2 T7',validact:'PLAY'},[...hand,'T7'],{signal:signal?AbortSignal.any([signal,deadline]):deadline});
 if(!/^PLAY [WBTZ][0-9]$/.test(decision.output.response)||!decision.visibleHand.includes(decision.output.response.split(' ')[1]))throw Error('引擎没有返回样本允许的出牌');
 const {off,pRon}=decision.metrics;
 if(!Number.isFinite(off)||!Number.isFinite(pRon)||pRon<0||pRon>1)throw Error('样本决策缺少有效 analyze off/p_ron');
 results.push({searchSeconds:seconds,executable,response:decision.output.response,off,pRon,elapsedMs:decision.elapsedMs});
 await onProgress(`${seconds===3.3?engine.version:engine.reducedVersion}: Ready`);
 }
 return {version:engine.version,sha256:engine.sha256,warmedVersions:results};
}

export async function checkOperation({adapter,window}){
 return adapter.selfTestOutput(window);
}
