import {DEFAULT_PYTHON} from './runtime-paths.mjs';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

// Serialized OS metadata requests reuse one Python process; no screenshots.
export class WindowDiscovery{
 constructor(python=DEFAULT_PYTHON){
  this.worker=spawn(python,['-u','-X','utf8',fileURLToPath(new URL('./find-game-window.py',import.meta.url)),'--serve'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  this.lines=createInterface({input:this.worker.stdout});this.stderr='';
  this.worker.stderr.on('data',b=>this.stderr=(this.stderr+b).slice(-1000));
  this.lines.on('line',line=>{const p=this.pending;if(!p)return;this.pending=null;clearTimeout(p.timer);try{p.resolve(JSON.parse(line));}catch(e){p.reject(e);}});
  this.worker.on('error',e=>this.fail(e));
  this.worker.stdin.on('error',e=>this.fail(e));
  this.worker.on('exit',code=>this.fail(Error(`窗口检测进程退出 ${code}: ${this.stderr}`)));
 }
 fail(error){this.error=error;if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(error);this.pending=null;}}
 discover(){
  if(this.error)return Promise.reject(this.error);
  if(this.pending)return Promise.reject(Error('Window discovery already pending'));
  return new Promise((resolve,reject)=>{
   this.pending={resolve,reject,timer:setTimeout(()=>{this.fail(Error('窗口检测超时'));this.worker.kill();},5000)};
   this.worker.stdin.write('\n');
  });
 }
 close(){this.fail(Error('窗口检测已关闭'));this.lines.close();this.worker.stdin.end();}
}
