import {open,readFile,unlink} from 'node:fs/promises';

export async function acquireProcessLock(path,contents,{isAlive=pid=>{
 try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}
}}={}){
 for(let attempt=0;attempt<3;attempt++){
  let handle;
  try{handle=await open(path,'wx');}
  catch(error){
   if(error.code!=='EEXIST')throw error;
   let raw;
   try{raw=await readFile(path,'utf8');}catch(e){if(e.code==='ENOENT')continue;throw e;}
   let owner;try{const value=JSON.parse(raw);owner=typeof value==='number'?value:value.pid;}catch{}
   // Unknown or live owners must never be displaced.
   if(!Number.isInteger(owner)||owner<=0||await isAlive(owner))
    throw Error(`运行锁仍被占用或无法确认归属：${path}（PID ${owner??'未知'}）`);
   try{if(await readFile(path,'utf8')===raw)await unlink(path);}catch(e){if(e.code!=='ENOENT')throw e;}
   continue;
  }
  try{await handle.writeFile(contents,'utf8');return handle;}
  catch(error){await handle.close();await unlink(path);throw error;}
 }
 throw Error(`无法取得运行锁：${path}`);
}
