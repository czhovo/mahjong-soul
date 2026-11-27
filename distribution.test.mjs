import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile,access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {parseResidentArgs} from './resident.mjs';
import {DEFAULT_EXECUTABLE} from './engine-builds.mjs';
import {SearchBudget} from './search-budget.mjs';

const root=fileURLToPath(new URL('./',import.meta.url));

test('public distribution excludes private screenshots, fixtures, game bundles, and engine binaries',async()=>{
 for(const path of [
  'startup-checks.mjs','startup-recognition-fields.mjs',
  'startup-fixtures','sanma/startup-fixtures',
  'templates/result-pages','yakuman','saved-win-settlements',
  'static-assets/coded/original','static-assets/coded/replacement','static-assets/coded/active-bundle-manifest.json',
  'REFACTOR_REPORT.md','bin/windows-x64','bin/windows-arm64','engine-source',
 ])
  await assert.rejects(access(join(root,path)),{code:'ENOENT'});
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

test('default engine is v111 and v15 CLI arguments work as expected',()=>{
 assert.match(DEFAULT_EXECUTABLE,/v111-5p5/);
 assert.equal(parseResidentArgs(['-b']).briefPostMatch,true);
 assert.equal(parseResidentArgs(['-g']).goldRoom,true);
 assert.equal(parseResidentArgs(['-t']).jadeRoom,true);
 assert.equal(parseResidentArgs([]).autoStart,false);
 assert.equal(parseResidentArgs(['-3','-f','-l']).shortOnly,true);
 for(const flag of ['-b','-s','-g'])assert.throws(()=>parseResidentArgs(['-t',flag]));
 assert.throws(()=>parseResidentArgs(['-3','-4']));
 const budget=new SearchBudget(true);
 assert.equal(budget.seconds,3.5);
 assert.equal(budget.reduced,2.2);
});

test('runtime does not require development machine user or Python paths',async()=>{
 for(const name of await readdir(root))if(/\.(mjs|py|ps1|ahk)$/.test(name)&&name!=='distribution.test.mjs'){
  const code=await readFile(join(root,name),'utf8');
  assert.ok(!/[A-Z]:[/\\](?:Users|ProgramData)[/\\]|[A-Z]:[/\\]SteamLibrary|20888|anaconda3/i.test(code),name);
 }
});

test('required calibrated digit templates are shipped separately from logs',async()=>{
 for(const name of ['visible-wall-digit-5.png','visible-wall-digit-5b.png','visible-wall-digit-6.png','visible-wall-digit-6-0.png','visible-wall-digit-6-1.png','visible-wall-digit-8.png','visible-wall-digit-3.png','visible-hand-digit-4.png'])
  await access(join(root,'templates/digits',name));
});

test('release manifest pins v111 & v21 engines and verified runtime helpers',async()=>{
 const manifest=JSON.parse(await readFile(join(root,'release-manifest.json'),'utf8'));
 const pins=JSON.parse(await readFile(join(root,'engine-pins.json'),'utf8'));
 assert.equal(manifest.controller,'v15');
 assert.equal(manifest.recognize,'v7');
 assert.equal(manifest.execute,'v4');
 assert.equal(JSON.parse(await readFile(join(root,'package.json'),'utf8')).version,'15.0.0');
 assert.equal(manifest.engines.length,6);
 for(const entry of manifest.engines){
  const releaseKey=entry.players===3?'v21':'v111';
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
