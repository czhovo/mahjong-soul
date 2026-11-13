import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile,access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {runResident} from './resident-core.mjs';
import {TerminalLog} from './terminal-log.mjs';
import {ClientAdapter} from './client-adapter.mjs';
import {AhkDriver} from './ahk-driver.mjs';
import {MatchContinuation} from './match-continuation.mjs';
import {parseResidentArgs} from './resident.mjs';
import {DEFAULT_EXECUTABLE} from './engine-builds.mjs';
import {SearchBudget} from './search-budget.mjs';
const root=fileURLToPath(new URL('./',import.meta.url));

test('public runtime contains no self-test routes or private calibration images',async()=>{
 assert.equal(ClientAdapter.prototype.selfTestOutput,undefined);
 assert.equal(AhkDriver.prototype.selfTestTitle,undefined);
 for(const path of ['startup-checks.mjs','startup-recognition-fields.mjs','doctor.mjs','startup-fixtures','sanma/startup-fixtures','templates/result-pages/own-win.png','templates/result-pages/own-rank.png','engines/v92-hp'])
  await assert.rejects(access(join(root,path)),{code:'ENOENT'});
 const code=await readFile(join(root,'resident-core.mjs'),'utf8');
 assert.ok(!/StartupChecks|checkRecognition|checkDecision|checkOperation|startupDecisionReady/.test(code));
});

test('normal public startup never executes search warmup, fixture recognition or a test click',async t=>{
 const folder=await mkdtemp(join(root,'private-startup-check-'));
 const controller=new AbortController(),lines=[];
 t.mock.method(TerminalLog.prototype,'line',line=>lines.push(line));
 try{
  await runResident({directory:folder,executable:join(root,'bin/windows-x64/tingfeng-v96-hp-2p2.exe'),signal:controller.signal,services:{
   lockPath:join(folder,'resident.lock'),discover:async()=>{controller.abort();return [];},
   checkRecognition:()=>assert.fail('No recognition self-test'),checkDecision:()=>assert.fail('No engine warmup'),checkOperation:()=>assert.fail('No self-test click'),
   makeCapture:()=>assert.fail('No game capture requested'),play:()=>assert.fail('No gameplay requested'),
  }});
  assert.ok(lines.includes('等待进入对局'));
  assert.ok(!lines.some(line=>/Checking|Ready/.test(line)));
 }finally{assert.ok(folder.startsWith(root));await rm(folder,{recursive:true,force:true});}
});

test('public results have no nickname reader, result image archive or terminal formatter',async()=>{
 for(const path of ['result_page_vision.py','result_page_archive.py','configure-player.py','match-result-log.mjs','screenshot-log.mjs'])
  await assert.rejects(access(join(root,path)),{code:'ENOENT'});
 assert.equal(ClientAdapter.prototype.finalizeMatchScreenshot,undefined);
 const worker=await readFile(join(root,'recognition-worker.py'),'utf8');
 assert.ok(!/read_result_page|ResultPageArchive|name_match|finalize_match/.test(worker));
 const lines=[],terminal=new TerminalLog();terminal.line=line=>lines.push(line);
 for(const kind of ['own-win-settlement','match-result'])terminal.observe({id:kind,round:{},hand:{tiles:[],complete:false},controls:{},result_page:{kind,complete:true,name:'Example',points:32000,rank:1,ptChange:100}});
 assert.ok(!lines.some(line=>/终局结果|终局结算|已保存图片|^和牌/.test(line)));
});

test('public post-match buttons still execute after two seconds without saving a result frame',async()=>{
 const flow=new MatchContinuation();let sent=0;
 const frame={id:'result',terminal_phase:{name:'match_end',controls:{CONFIRM:{center:[100,200]}}}};
 const adapter={sendClick:async()=>{sent++;},finalizeMatchScreenshot:()=>assert.fail('No result image saving')};
 assert.equal(await flow.step(frame,adapter,0),null);
 assert.equal(await flow.step(frame,adapter,2000),'CONFIRM');assert.equal(sent,1);
});
test('all local JS imports in the distribution exist',async()=>{
 for(const name of await readdir(root))if(name.endsWith('.mjs')){
  const code=await readFile(join(root,name),'utf8');
  for(const match of code.matchAll(/(?:from\s*|import\s*\()['"](\.{1,2}\/[^'"]+\.mjs)['"]/g)){
   assert.ok(!match[1].startsWith('../'),'External development import: '+name);
   await access(join(root,match[1]));
  }
 }
});
test('default is v96 and supported room CLI remains available',()=>{
 assert.match(DEFAULT_EXECUTABLE,/v96-hp-5p5/);
 assert.equal(parseResidentArgs(['-b']).briefPostMatch,true);
 assert.equal(parseResidentArgs(['-g']).goldRoom,true);
});
test('jade is mutually exclusive with the other rooms',()=>{
 assert.equal(parseResidentArgs(['-t']).jadeRoom,true);
 for(const flag of ['-b','-s','-g'])assert.throws(()=>parseResidentArgs(['-t',flag]));
});

test('runtime does not require the development machine user or Python path',async()=>{
 for(const name of await readdir(root))if(/\.(mjs|py|ps1|ahk)$/.test(name)&&name!=='distribution.test.mjs'){
  const code=await readFile(join(root,name),'utf8');
  assert.ok(!/[A-Z]:[/\\](?:Users|ProgramData)[/\\]|[A-Z]:[/\\]SteamLibrary/.test(code),name);
 }
});
test('required calibrated digit templates are shipped separately from logs',async()=>{
 for(const name of ['visible-wall-digit-5.png','visible-wall-digit-5b.png','visible-wall-digit-6.png','visible-wall-digit-6-0.png','visible-wall-digit-6-1.png','visible-wall-digit-8.png','visible-wall-digit-3.png','visible-hand-digit-4.png'])await access(join(root,'templates/digits',name));
});

test('CLI combinations preserve the v7 fast-start and fixed low budget',()=>{
 assert.throws(()=>parseResidentArgs([]),/必须使用 -f/);
 assert.throws(()=>parseResidentArgs(['-b','-s']));
 assert.throws(()=>parseResidentArgs(['-3','-4','-f']));
 for(const args of [['-3','-f','-l'],['-l','-3','-f']]){
  const parsed=parseResidentArgs(args);
  assert.equal(parsed.players,3);assert.equal(parsed.singleMatch,true);assert.equal(parsed.shortOnly,true);
 }
 const budget=new SearchBudget(true);assert.equal(budget.seconds,2.2);assert.equal(budget.reduced,2.2);
});

test('all 12 distributed engines match their architecture and pinned checksum',async()=>{
 const manifest=JSON.parse(await readFile(join(root,'release-manifest.json'),'utf8'));
 assert.equal(manifest.engines.length,12);
 const keys=new Set();
 for(const entry of manifest.engines){
  const data=await readFile(join(root,entry.source));
  assert.equal(data.subarray(0,2).toString(),'MZ');
  const header=data.readUInt32LE(0x3c);
  assert.equal(data.readUInt32LE(header),0x4550);
  assert.equal(data.readUInt16LE(header+4),entry.architecture==='arm64'?0xaa64:0x8664);
  assert.equal(createHash('sha256').update(data).digest('hex'),entry.sha256,entry.source);
  assert.ok(!keys.has(`${entry.architecture}/${entry.players}/${entry.profile}`));
  keys.add(`${entry.architecture}/${entry.players}/${entry.profile}`);
 }
});

test('both table modes recognize every published build and its search budget',()=>{
 for(const mode of ['yonma','sanma']){
  const result=spawnSync(process.execPath,['--input-type=module','-e',`
   import {readFile} from 'node:fs/promises';
   import {verifyEngineBuild} from './engine-builds.mjs';
   const entries=JSON.parse(await readFile('release-manifest.json','utf8')).engines;
   for(const e of entries.filter(x=>x.players===${mode==='sanma'?3:4})){
    const result=await verifyEngineBuild(e.source,false);
    if(result.version!==e.version||result.searchSeconds!==e.searchSeconds)throw Error(e.source);
   }
  `],{cwd:root,env:{...process.env,MAJSOUL_CONTROLLER_GAME:mode},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
 }
});
