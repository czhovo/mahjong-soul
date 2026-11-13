import {spawn} from 'node:child_process';
import {watch} from 'node:fs';
import {mkdir,open,stat,appendFile,readFile,unlink,access,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

// One resident output process. File notifications carry receipts; no model
// polling and no per-action interpreter launch. Never retries uncertain input.
export class AhkDriver {
  constructor(root){this.root=root;this.pending=new Map();this.receipts=new Map();this.offset=0;this.tail='';}
  async start(){
    if(this.ready)return this.ready;
    this.ready=this.initialize();return this.ready;
  }
  async initialize(){
    const dir=join(this.root,'queue');await mkdir(dir,{recursive:true});
    this.path=join(dir,'ack.tsv');await appendFile(this.path,'');this.offset=(await stat(this.path)).size;
    this.watcher=watch(dir,(_event,name)=>{if(String(name)==='ack.tsv')this.drain();});
    const token=randomUUID();const ready=this.wait(token,5000);
    this.child=spawn(join(this.root,'runtime/ahk-v2/AutoHotkey64.exe'),['/ErrorStdOut',join(this.root,'output.ahk'),'--worker',token],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    this.diagnostics='';
    this.child.stdout.on('data',b=>{this.diagnostics+=b;});
    this.child.stderr.on('data',b=>{this.diagnostics+=b;});
    this.child.on('error',e=>this.fail(e));
    this.child.on('exit',code=>this.fail(Error(`AHK worker exited ${code}: ${this.diagnostics}`)));
    try{await ready;}catch(error){await this.close();throw error;}
  }
  async drain(){
    if(this.reading){this.again=true;return;}
    this.reading=true;
    try{
      do{
        this.again=false;const size=(await stat(this.path)).size;
        if(size<this.offset)throw Error('AHK receipt log unexpectedly truncated');
        if(size===this.offset)continue;
        const buffer=Buffer.alloc(size-this.offset);
        const file=await open(this.path,'r');let bytesRead;
        try{({bytesRead}=await file.read(buffer,0,buffer.length,this.offset));}finally{await file.close();}
        this.offset+=bytesRead;
        this.tail+=buffer.subarray(0,bytesRead).toString('utf8');let newline;
        while((newline=this.tail.indexOf('\n'))>=0){
          const line=this.tail.slice(0,newline).trim();this.tail=this.tail.slice(newline+1);
          const [id,status]=line.split('\t');
          const entry=this.pending.get(id);
          if(entry){clearTimeout(entry.timer);this.pending.delete(id);status==='input_sent'||status==='ready'?entry.resolve(line):entry.reject(Error(`AHK rejected input: ${line}`));}
          else this.receipts.set(id,line);
        }
      }while(this.again);
    }catch(error){this.fail(error);}finally{this.reading=false;}
  }
  wait(id,timeoutMs=3000){
    if(this.error)return Promise.reject(this.error);
    const cached=this.receipts.get(id);
    if(cached){this.receipts.delete(id);return ['input_sent','ready'].includes(cached.split('\t')[1])?Promise.resolve(cached):Promise.reject(Error(cached));}
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('AHK receipt timeout; outcome unknown, do not retry'));},timeoutMs);
      this.pending.set(id,{resolve,reject,timer});
    });
  }
  fail(error){this.error=error;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();}
  async close(){
    this.watcher?.close();this.fail(Error('AHK driver closed'));
    const child=this.child;
    if(child?.once&&child.exitCode===null&&child.signalCode===null){
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(Error('AHK worker did not exit; queue retained')),2000);
        child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill();
      });
    }else child?.kill();
  }
  async retireQueue(reason){
    // Never delete a request while the worker can still issue its click.
    await this.close();
    const directory=join(this.root,'queue');
    for(const name of ['request.tsv','processing.tsv']){
      const path=join(directory,name);let content;
      try{content=await readFile(path,'utf8');}catch(e){if(e.code==='ENOENT')continue;throw e;}
      await appendFile(join(directory,'retired-actions.jsonl'),JSON.stringify({at:new Date().toISOString(),reason,name,content})+'\n','utf8');
      await unlink(path).catch(e=>{if(e.code!=='ENOENT')throw e;});
    }
  }
}
