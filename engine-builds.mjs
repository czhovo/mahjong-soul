import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

// Pin known builds rather than accepting whatever hash a mutable manifest
// currently contains. Keep the resident default and startup gate together.
export const DEFAULT_EXECUTABLE=fileURLToPath(new URL('./engines/v70-parallel-3p3/bot.exe',import.meta.url));
const BUILDS=new Map([
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

export async function verifyEngineBuild(executable){
 const path=resolve(executable);
 const sha256=createHash('sha256').update(await readFile(path)).digest('hex');
 const version=BUILDS.get(sha256);
 if(!version)throw Error(`听风引擎文件版本不匹配：${path}；SHA-256 ${sha256}；仅支持已登记哈希的冻结构建`);
 let reducedExecutable;
 if(version==='v64-3p3-history'||version==='v64-3p3'){
  reducedExecutable=fileURLToPath(new URL(`./engines/v64-1p7-${version.endsWith('history')?'history':'base'}/bot.exe`,import.meta.url));
 }
 if(/^v(?:64|66|67|68|70)-parallel-3p3$/.test(version)){
  reducedExecutable=fileURLToPath(new URL(`./engines/${version.replace('3p3','1p7')}/bot.exe`,import.meta.url));
 }
 const reducedVersion=reducedExecutable?(await verifyEngineBuild(reducedExecutable)).version:undefined;
 return {version,reducedVersion,sha256,executable:path,...(reducedExecutable?{reducedExecutable}:{})};
}
