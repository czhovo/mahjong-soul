import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {GAME} from './game-rules.mjs';

// Pin known builds rather than accepting whatever hash a mutable manifest
// currently contains. Keep the resident default and startup gate together.
export const DEFAULT_EXECUTABLE=fileURLToPath(new URL(GAME.sanma?'./sanma/engines/observed-pon/tingyuan-v10-5p5.exe':'./engines/v96-hp-5p5/bot.exe',import.meta.url));
export const SHORT_EXECUTABLE=fileURLToPath(new URL(GAME.sanma?'./sanma/engines/observed-pon/tingyuan-v10-2p2.exe':'./engines/v96-hp-2p2/bot.exe',import.meta.url));
const BUILDS=new Map([
 ['ca9a6a81e0f7b54b58094c42f3883daa8ec461917273c7f10fa227304a04fb8d','v96-hp-5p5'],
 ['83c33903bb8bdcef06204359f39660b84da3d4f710babbf2db2fe2ff9c6f5098','v96-hp-3p5'],
 ['397d705bd5ccbf14079cf156de83fdb77ab19b4bbc1b3da59ff723f109605d47','v96-hp-2p2'],

 ['42b70b91e4f3f2926045f412bb9577fb167dbbec48f464f891b419b16f00e6ff','v96-hp-5p5'],
 ['a29dde80d64e3d352cf758ca83c7a197cca4d729ac51fb01c6f9bf16ec4021e7','v96-hp-3p5'],
 ['720c998f4aa0dd1756c35a127e8bbb2ef650608482aa7ff81e4f5b295939ec34','v96-hp-2p2'],
 ['5eaf196660199fbe1db976e2e3795a369250a8a8ca2f361bb3f028e46631eb3e','v92-hp-5p5'],
 ['95081aec76ef927f70c2d56eab91aa0a5ba936e531b63c39ea20eab9633005cc','v92-hp-3p5'],
 ['cdd53bd502d0a2dd527820211cfb4e9ad7f8e88b31efc934f1de9d647e31b205','v92-hp-2p2'],

 ['552a222e581bf8ca4b43cb56eec51da3994ba232c30f2609d9e2bb1b37f3ce8c','v91-hp-2p2'],
 ['057cc83f41da6bfa1e8b9f42c97a0ea6d358eb4abcac0bf8364bfebccc50dbfd','v91-hp-5p5'],
 ['a567c36ebd0efe35b564fd668f0c4f0b52bfb455d4695bb217e77eb4a8cd7bf8','v91-hp-3p5'],

 ['2d628516b514c45577f72976a3ef229d0d91e6d2622f3861fd547bc859f02f71','v88-hp-5p5'],
 ['e601b0a2e209ddc17173464e9d74a06e876a32300b2f2526c3e48290ddc8b352','v88-hp-3p5'],

 ['b7fe6e0ffb4fb9e4bd629d3db5724cce03a0d517b993253e46e22b394837ba89','v70-parallel-3p3'],
 ['0573dc4a1738846978d16f36a4257ce851dbed2478611e287e427c0674b0084a','v70-parallel-1p7'],
 ['7e15ca33e36ac5d585a93e43e15c457ae7035c9f6c08c18c70641015cd7dcfa2','v67-parallel-3p3'],
 ['6527ce071b77ddd9f0ae6ed219de4063e661f46e2071410a5f9e3720341bdbd2','v67-parallel-1p7'],
 ['939316128942df85e48bba71bd66d21116a2de96adf27ad558ad09ccd7bb8543','v68-parallel-3p3'],
 ['9d4370d30bd6b2c9ac66bbb08311988d47348e052b54676d8e6630e37e74d231','v68-parallel-1p7'],

 ['2792d5efe067e79b76e6dbe743fca293e728273320f0bf1d0fb4bdca21d9e395','v64-parallel-3p3'],
 ['c44ffaea088fdc5d5c813e975e9c8b58097e5b6ee377a42b7f4c9f7b530be62e','v64-parallel-1p7'],
 ['42ee9aa7640edd5e74b6020b7573a04d361e49f446b275629c90b92af9dedab0','v66-parallel-3p3'],
 ['c904cb6ab85f16b715659331067325f23c4044a2b2c46b4406a2836ad586b6ea','v66-parallel-1p7'],
 ['6e987cc2035b8ffce73fae0c7c35136f4829a0927b62db328e6f5789bdddde64','v64-3p3'],
 ['303668cffc434640e2479af34c8194d7f2c6ca1dd56145aa5d5fc098b44e4405','v64-3p3-history'],
 ['13fa1d5244bc2c95550aedec298f696b5c8c298cc93655ba5bf5448a7f7b96db','v64-1p7-history'],
 ['538fc4561f17932860bf810cd1c9ff7129d69c09912fe7d8c5c9f09935b5c426','v64-1p7-base'],
]);

export async function verifyEngineBuild(executable,withPair=true){
 const path=resolve(executable);
 const sha256=createHash('sha256').update(await readFile(path)).digest('hex');
 if(GAME.sanma){
  const legacyBuilds={
  "5p5": "349f80dbc3f70c8e54d246323daa7e01dee6c7ea9f57965781d53328864090f1",
  "3p5": "121e3f0b0c69a5594f857bf77bf18e2928305b03dcaa408d14168831a22ba113",
  "2p2": "7a92dc083c5b083b4ff9095f72df69062c3c857e2c9bdf516e1dab72fd76d048"
};
  const currentBuilds={
  "5p5": "32cdd78e0a6807f3244ed68bfa1932e75f6593b08cb2894c4536d2a36f22171a",
  "3p5": "244d9226e64cdf7d1660bdbb3cbc5841912d57a3e26ee70b97ec716a30b63b4f",
  "2p2": "fd491ea900a00d56900eea2586eea83b1aa100dc4e738ec48bc965f983bd4add"
};
  const armBuilds={"5p5":"61fb5c83f30a526d085916c30dc06408ee7d50580d272910cbf3cf0d615583cd","3p5":"bc675001a72bc5a35c4fa3b83ac68999b55e32353eebc059dde3e32209cc0b6a","2p2":"294e4fda3a69995ef6bf9d944e44761e14a8037678b7a314aaba3866b136c59b"};
  const builds=Object.values(armBuilds).includes(sha256)?armBuilds:Object.values(currentBuilds).includes(sha256)?currentBuilds:legacyBuilds;
  const profile=Object.keys(builds).find(k=>builds[k]===sha256);
  if(!profile)throw Error('听元 v10 构建未登记：'+sha256);
  const seconds={'5p5':5.5,'3p5':3.5,'2p2':2.2},next=withPair&&{'5p5':'3p5','3p5':'2p2'}[profile];
  const pair=next?await verifyEngineBuild(fileURLToPath(new URL(`./sanma/engines/${builds!==legacyBuilds?'observed-pon/':''}tingyuan-v10-${next}.exe`,import.meta.url)),false):null;
  if(pair&&pair.version!==`v10-${next}`)throw Error('听元配对档位不符');
  return {version:'v10-'+profile,searchSeconds:seconds[profile],executable:path,sha256,...(pair?{reducedVersion:pair.version,reducedExecutable:pair.executable,reducedSearchSeconds:pair.searchSeconds}:{})};
 }
 const version=BUILDS.get(sha256);
 if(!version)throw Error(`听风引擎文件版本不匹配：${path}；SHA-256 ${sha256}；仅支持已登记哈希的冻结构建`);
 let reducedExecutable;
 if(withPair&&/^v(?:91|92|96)-hp-3p5$/.test(version))reducedExecutable=fileURLToPath(new URL(`./engines/${version.replace('3p5','2p2')}/bot.exe`,import.meta.url));
 if(withPair&&/^v(?:91|92|96)-hp-5p5$/.test(version))reducedExecutable=fileURLToPath(new URL(`./engines/${version.replace('5p5','3p5')}/bot.exe`,import.meta.url));
 if(version==='v88-hp-5p5')reducedExecutable=fileURLToPath(new URL('./engines/v88-hp-3p5/bot.exe',import.meta.url));
 if(version==='v64-3p3-history'||version==='v64-3p3'){
  reducedExecutable=fileURLToPath(new URL(`./engines/v64-1p7-${version.endsWith('history')?'history':'base'}/bot.exe`,import.meta.url));
 }
 if(/^v(?:64|66|67|68|70)-parallel-3p3$/.test(version)){
  reducedExecutable=fileURLToPath(new URL(`./engines/${version.replace('3p3','1p7')}/bot.exe`,import.meta.url));
 }
 const reducedVersion=reducedExecutable?(await verifyEngineBuild(reducedExecutable,false)).version:undefined;
 return {version,reducedVersion,sha256,executable:path,searchSeconds:version.endsWith('-2p2')?2.2:version.endsWith('-3p5')?3.5:version.endsWith('-5p5')?5.5:3.3,reducedSearchSeconds:/^v(?:91|92|96)-hp-3p5$/.test(version)?2.2:version.endsWith('-5p5')?3.5:1.7,...(reducedExecutable?{reducedExecutable}:{})};
}
