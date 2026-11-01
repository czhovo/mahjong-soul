import {appendFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {dirname} from 'node:path';

export class BackgroundWrites {
 constructor(report=error=>console.error(`记录写入失败：${error.message}`)){this.jobs=new Map();this.errors=[];this.report=report;}
 enqueue(key,write){
  const previous=this.jobs.get(key)??Promise.resolve();
  const job=previous.then(write).catch(error=>{this.errors.push(error);this.report(error);});
  this.jobs.set(key,job);
  job.then(()=>{if(this.jobs.get(key)===job)this.jobs.delete(key);});
 }
 async flush(){
  while(this.jobs.size)await Promise.all([...this.jobs.values()]);
  if(this.errors.length)throw new AggregateError(this.errors.splice(0),'记录未完整落盘');
 }
}
export const backgroundWrites=new BackgroundWrites();
const directories=new Set();
async function prepare(path){const dir=dirname(path);if(!directories.has(dir)){await mkdir(dir,{recursive:true});directories.add(dir);}}
export function appendEvidence(path,text){backgroundWrites.enqueue(path,async()=>{await prepare(path);await appendFile(path,text,'utf8');});}
export function saveStatus(path,text){backgroundWrites.enqueue(path,async()=>{await prepare(path);const temp=path+'.tmp';await writeFile(temp,text,'utf8');await rename(temp,path);});}
export const flushEvidence=()=>backgroundWrites.flush();
