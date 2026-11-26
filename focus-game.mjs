import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {access} from 'node:fs/promises';
const run=promisify(execFile);
export function createFocusController(activate,{now=()=>performance.now(),sleep=delay}={}){
 let pending=null,lastStart=-Infinity;
 return window=>{
  if(!window?.id)return Promise.reject(Error('Game window handle required'));
  if(pending)return pending;
  pending=(async()=>{
   const wait=Math.max(0,1000-(now()-lastStart));
   if(wait)await sleep(wait);
   lastStart=now();
   return activate(window);
  })().finally(()=>{pending=null;});
  return pending;
 };
}
const activate=createFocusController(async window=>{
 await run(fileURLToPath(new URL('./runtime/ahk-v2/AutoHotkey64.exe',import.meta.url)),
  ['/ErrorStdOut',fileURLToPath(new URL('./focus-game.ahk',import.meta.url)),String(window.id)],
  {windowsHide:true,timeout:2000});
});
export async function focusGame(window){return activate(window);}
export async function clickGameTitle(window,adapter=null){
 if(process.env.MAJSOUL_VIRTUAL_POINTER==='1'){
  // Use the resident driver's virtual pointer owner, not a second AHK
  // process whose short lifetime would invalidate the coordinate lease.
  const frame=adapter?.latest;
  if(!frame||adapter.outputLock||adapter.modalOutput||!Number.isFinite(frame.clientWidth)||!Number.isFinite(frame.clientHeight))return false;
  await adapter.sendClick(frame,[1+Math.round(frame.clientWidth*.05),31+Math.round(frame.clientHeight*.95)],'background');
  return true;
 }
 if(adapter?.outputLock||adapter?.modalOutput||adapter?.outputDriver?.inFlight)return false;
 for(const name of ['request.tsv','processing.tsv']){
  try{await access(fileURLToPath(new URL('./queue/'+name,import.meta.url)));return false;}
  catch(error){if(error.code!=='ENOENT')throw error;}
 }
 await run(fileURLToPath(new URL('./runtime/ahk-v2/AutoHotkey64.exe',import.meta.url)),
  ['/ErrorStdOut',fileURLToPath(new URL('./focus-game.ahk',import.meta.url)),String(window.id),'--title-click'],
  {windowsHide:true,timeout:2000});
 return true;
}
