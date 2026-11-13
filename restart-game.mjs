import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const run=promisify(execFile);
export async function restartGame(window,{execute=run}={}){
 const executable=window?.app?.startsWith('process:')?window.app.slice(8):'';
 if(!Number.isSafeInteger(window?.id)||window.id<=0||!/(?:^|[\\/])Jantama_MahjongSoul\.exe$/i.test(executable))throw Error('Verified Mahjong Soul window required for restart');
 const result=await execute('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./restart-game.ps1',import.meta.url)),'-WindowId',String(window.id),'-Executable',executable],{windowsHide:true,timeout:20000});
 return JSON.parse(result.stdout.trim());
}
