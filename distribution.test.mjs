import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile,access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {parseResidentArgs} from './resident.mjs';
import {DEFAULT_EXECUTABLE} from './engine-builds.mjs';
const root=fileURLToPath(new URL('./',import.meta.url));
test('all local JS imports in the distribution exist',async()=>{
 for(const name of await readdir(root))if(name.endsWith('.mjs')){
  const code=await readFile(join(root,name),'utf8');
  for(const match of code.matchAll(/(?:from\s*|import\s*\()['"](\.\/[^'"]+\.mjs)['"]/g))await access(join(root,match[1]));
 }
});
test('default is v70 and supported room CLI remains available',()=>{
 assert.match(DEFAULT_EXECUTABLE,/v70-parallel-3p3/);
 assert.equal(parseResidentArgs(['-b']).briefPostMatch,true);
 assert.equal(parseResidentArgs(['-g']).goldRoom,true);
});
test('runtime does not require the development machine user or Python path',async()=>{
 for(const name of await readdir(root))if(/\.(mjs|py|ps1|ahk)$/.test(name)&&name!=='distribution.test.mjs'){
  const code=await readFile(join(root,name),'utf8');
  assert.ok(!/C:[/\\]Users[/\\]20888|ProgramData[/\\]anaconda3|F:[/\\]SteamLibrary/.test(code),name);
 }
});
test('required calibrated digit templates are shipped separately from logs',async()=>{
 for(const name of ['visible-wall-digit-5.png','visible-wall-digit-5b.png','visible-wall-digit-6.png','visible-wall-digit-6-0.png','visible-wall-digit-6-1.png','visible-wall-digit-8.png','visible-wall-digit-3.png','visible-hand-digit-4.png'])await access(join(root,'templates/digits',name));
});
