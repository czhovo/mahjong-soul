import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile,access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
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

test('public runtime contains no self-test routes, engine binaries, or private calibration images',async()=>{
 assert.equal(ClientAdapter.prototype.selfTestOutput,undefined);
 assert.equal(AhkDriver.prototype.selfTestFocus,undefined);
 assert.equal(AhkDriver.prototype.selfTestTitle,undefined);
 for(const path of [
  'startup-checks.mjs','startup-recognition-fields.mjs','doctor.mjs',
  'startup-fixtures','sanma/startup-fixtures',
  'templates/result-pages','templates/result-pages/own-win.png','templates/result-pages/own-rank.png',
  'yakuman','REFACTOR_REPORT.md','bin/windows-x64','bin/windows-arm64','engine-source',
 ])
  await assert.rejects(access(join(root,path)),{code:'ENOENT'});
 const code=await readFile(join(root,'resident-core.mjs'),'utf8');
 assert.ok(!/StartupChecks|checkRecognition|checkDecision|checkOperation|startupDecisionReady/.test(code));
});

test('public results do not archive images or print identifying details',async()=>{
 for(const path of ['result_page_vision.py','result_page_archive.py','win_yaku.py','configure-player.py','match-result-log.mjs','screenshot-log.mjs'])
  await assert.rejects(access(join(root,path)),{code:'ENOENT'});
 assert.equal(ClientAdapter.prototype.finalizeMatchScreenshot,undefined);
 const worker=await readFile(join(root,'recognition-worker.py'),'utf8');
 assert.ok(!/read_result_page|ResultPageArchive|finalize_match|win_yaku/.test(worker));
 const lines=[],terminal=new TerminalLog();terminal.line=line=>lines.push(line);
 for(const kind of ['own-win-settlement','match-result'])
  terminal.observe({id:kind,round:{},hand:{tiles:[],complete:false},controls:{},result_page:{kind,complete:true,name:'Example',points:32000,rank:1,ptChange:100}});
 assert.ok(!lines.some(line=>/终局结果|终局结算|已保存图片|^和牌/.test(line)));
});

test('public post-match buttons still execute after two seconds without saving a result frame',async()=>{
 const flow=new MatchContinuation();let sent=0;
 const frame={id:'result',terminal_phase:{name:'match_end',controls:{CONFIRM:{center:[100,200]}}}};
 const adapter={sendClick:async()=>{sent++;},finalizeMatchScreenshot:()=>assert.fail('No result image saving')};
 assert.equal(await flow.step(frame,adapter,0),null);
 assert.equal(await flow.step(frame,adapter,2000),'CONFIRM');assert.equal(sent,1);
});

test('all local JS imports in the distribution exist and stay within repository',async()=>{
 for(const name of await readdir(root))if(name.endsWith('.mjs')){
  const code=await readFile(join(root,name),'utf8');
  for(const match of code.matchAll(/(?:from\s*|import\s*\()['"](\.{1,2}\/[^'"]+\.mjs)['"]/g)){
   assert.ok(!match[1].startsWith('../'),'External development import: '+name+' -> '+match[1]);
   await access(join(root,match[1]));
  }
 }
});

test('default is v103 and supported room CLI remains available',()=>{
 assert.match(DEFAULT_EXECUTABLE,/v103-5p5/);
 assert.equal(parseResidentArgs(['-b']).briefPostMatch,true);
 assert.equal(parseResidentArgs(['-g']).goldRoom,true);
 assert.equal(parseResidentArgs(['-t']).jadeRoom,true);
 for(const flag of ['-b','-s','-g'])assert.throws(()=>parseResidentArgs(['-t',flag]));
});

test('runtime does not require the development machine user or Python path',async()=>{
 for(const name of await readdir(root))if(/\.(mjs|py|ps1|ahk)$/.test(name)&&name!=='distribution.test.mjs'){
  const code=await readFile(join(root,name),'utf8');
  assert.ok(!/[A-Z]:[/\\](?:Users|ProgramData)[/\\]|[A-Z]:[/\\]SteamLibrary|20888|anaconda3/i.test(code),name);
 }
});

test('required calibrated digit templates are shipped separately from logs',async()=>{
 for(const name of ['visible-wall-digit-5.png','visible-wall-digit-5b.png','visible-wall-digit-6.png','visible-wall-digit-6-0.png','visible-wall-digit-6-1.png','visible-wall-digit-8.png','visible-wall-digit-3.png','visible-hand-digit-4.png'])
  await access(join(root,'templates/digits',name));
});

test('CLI combinations preserve fast-start, --name compatibility, and opt-in flags',()=>{
 assert.throws(()=>parseResidentArgs([]),/必须使用 -f/);
 assert.throws(()=>parseResidentArgs(['-b','-s']));
 assert.throws(()=>parseResidentArgs(['-3','-4','-f']));
 for(const args of [['-3','-f','-l'],['-l','-3','-f']]){
  const parsed=parseResidentArgs(args);
  assert.equal(parsed.players,3);assert.equal(parsed.singleMatch,true);assert.equal(parsed.shortOnly,true);
 }
 const defaults=parseResidentArgs(['-g']);
 assert.ok(!defaults.lagRecovery&&!defaults.naku);
 const enabled=parseResidentArgs(['--naku','-f','--lag','-3']);
 assert.equal(enabled.lagRecovery,true);assert.equal(enabled.naku,true);
 assert.deepEqual(parseResidentArgs(['-g','--name']),parseResidentArgs(['-g']));
 assert.throws(()=>parseResidentArgs(['-g','--no-name']));
 const budget=new SearchBudget(true);assert.equal(budget.seconds,3.5);assert.equal(budget.reduced,2.2);
});

test('release manifest pins v103 & v13 engines and verified runtime helpers',async()=>{
 const manifest=JSON.parse(await readFile(join(root,'release-manifest.json'),'utf8'));
 const pins=JSON.parse(await readFile(join(root,'engine-pins.json'),'utf8'));
 assert.equal(manifest.controller,'v12');
 assert.equal(JSON.parse(await readFile(join(root,'package.json'),'utf8')).version,'12.0.0');
 assert.equal(manifest.engines.length,6);
 for(const entry of manifest.engines){
  const releaseKey=entry.players===3?'v13':'v103';
  assert.equal(entry.sha256,pins[releaseKey][entry.profile]);
 }
 assert.equal(manifest.pointer.length,2);
 for(const entry of manifest.pointer){
  const data=await readFile(join(root,entry.source));
  assert.equal(data.readUInt16LE(data.readUInt32LE(0x3c)+4),0x014c);
  assert.equal(createHash('sha256').update(data).digest('hex'),entry.sha256);
 }
 const captureData=await readFile(join(root,manifest.capture.source));
 assert.equal(createHash('sha256').update(captureData).digest('hex'),manifest.capture.sha256);
 for(const name of ['output.ahk','sanma/output.ahk']){
  const code=await readFile(join(root,name),'utf8');
  assert.doesNotMatch(code,/startup_focus/);
 }
});

test('four-player hand changes require the next label and matching dealer rotation',async()=>{
 const {changedRound}=await import('./round-boundary.mjs');
 const frame=(wind,hand,honba,offset)=>({round:{wind,hand_number:{value:hand},counters:{honba},
  seat_identity:{verified:true,seats:Object.fromEntries(['self','right','opposite','left'].map((p,i)=>[p,(i+offset)%4]))}}});
 const previous=frame(0,4,1,0);
 assert.ok(changedRound(previous,frame(0,4,2,0)));
 assert.ok(changedRound(previous,frame(1,1,0,3)));
 assert.ok(!changedRound(previous,frame(1,1,0,0)));
 assert.ok(!changedRound(previous,frame(1,2,0,3)));
 assert.ok(!changedRound(previous,previous));
});

test('a North decision uses the fixed toolbar point and does not repeat an enabled toggle',async()=>{
 const {applyKitaDecision}=await import('./auto-kita.mjs');
 const frame={id:'first',clientWidth:1920,clientHeight:1080,auto_kita:{verified:true,enabled:false}};
 const sent=[];const adapter={latest:frame,sendClick:(...args)=>sent.push(args)};
 assert.equal((await applyKitaDecision(frame,adapter)).sent,true);
 assert.deepEqual(sent,[[frame,[40,802],'toggle']]);
 const next={...frame,id:'second',captureStartedMono:performance.now()+1,auto_kita:{verified:true,enabled:true}};
 assert.equal((await applyKitaDecision(next,adapter)).sent,false);assert.equal(sent.length,1);
});

test('nickname glyphs survive worker replacement in memory and are removed before logging',async()=>{
 const id='synthetic-window';
 const adapter=()=>Object.assign(Object.create(ClientAdapter.prototype),{window:{id},pending:new Map(),restoreNicknameOnRequest:true});
 const source=adapter(),result={id:'first',nicknameUpdate:{lobby:'synthetic-reference'}};
 const observation=new Promise(resolve=>source.pending.set('first',{resolve}));
 source.receiveRecognitionResult(result);
 assert.deepEqual(await observation,{id:'first'});
 const send=async target=>{
  let payload;
  target.worker={stdin:{write:line=>{
    payload=JSON.parse(line);target.receiveRecognitionResult({id:payload.id});
  }}};
  await target.recognitionRequest({id:'next'});
  return payload;
 };
 const sameWindow=adapter();
 assert.deepEqual((await send(sameWindow)).restoreNickname,{lobby:'synthetic-reference'});
 assert.equal((await send(sameWindow)).restoreNickname,undefined);
 const another=adapter();another.window={id:'different'};
 assert.equal((await send(another)).restoreNickname,undefined);
});
