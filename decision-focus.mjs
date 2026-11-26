import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const executable=fileURLToPath(new URL('./runtime/ahk-v2/AutoHotkey64.exe',import.meta.url));
const script=fileURLToPath(new URL('./decision-focus.ahk',import.meta.url));

export function holdDecisionFocus(windowId,signal){
  signal?.throwIfAborted();
  const child=spawn(executable,['/ErrorStdOut',script,String(windowId)],{windowsHide:true,stdio:'pipe'});
  const release=()=>child.stdin.end();
  signal?.addEventListener('abort',release,{once:true});
  let output='',diagnostic='',onReady;
  const acquired=new Promise(resolve=>{onReady=resolve;});
  child.stdout.setEncoding('utf8').on('data',chunk=>{
    output+=chunk;
    if(output.trim()==='ready')onReady();
  });
  child.stderr.setEncoding('utf8').on('data',chunk=>{diagnostic+=chunk;});
  const closed=new Promise((resolve,reject)=>{
    child.once('error',reject);
    child.once('close',code=>{
      signal?.removeEventListener('abort',release);
      if(code===0&&output.trim()==='ready')resolve();
      else reject(Error('按钮决策焦点操作失败：'+(diagnostic.trim()||output.trim()||code)));
    });
  });
  // The helper may fail during restoration, after acquisition was acknowledged.
  const ready=Promise.race([acquired,closed]);
  return {ready,async release(){release();await closed;}};
}
