import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {GAME} from './game-rules.mjs';
import {VERSIONS} from './version-info.mjs';

const release=GAME.sanma?VERSIONS.tingyuan:VERSIONS.tingfeng;
const profiles=['5p5','3p5','2p2'];
function executableFor(profile){
 const relative=GAME.sanma?`./sanma/engines/tingyuan-${release}-${profile}.exe`:
  `./engines/${release}-${profile}/bot.exe`;
 return fileURLToPath(new URL(relative,import.meta.url));
}
export const DEFAULT_EXECUTABLE=executableFor('5p5');
export const SHORT_EXECUTABLE=executableFor('3p5');

export async function verifyEngineBuild(executable,withPair=true){
 const path=resolve(executable);
 const pins=JSON.parse(await readFile(new URL('./engine-pins.json',import.meta.url),'utf8'));
 const sha256=createHash('sha256').update(await readFile(path)).digest('hex');
 const profile=profiles.find(p=>pins[release]?.[p]===sha256);
 if(!profile)throw Error(`引擎与听风执牌 ${VERSIONS.interface} 的构建记录不匹配：${path}`);
 const build={version:`${release}-${profile}`,executable:path,sha256,searchSeconds:Number(profile.replace('p','.'))};
 const next=profiles[profiles.indexOf(profile)+1];
 if(withPair&&next){
  const pair=await verifyEngineBuild(executableFor(next),false);
  if(pair.version!==`${release}-${next}`)throw Error('引擎时间档位不符');
  Object.assign(build,{reducedVersion:pair.version,reducedExecutable:pair.executable,reducedSearchSeconds:pair.searchSeconds});
 }
 return build;
}
