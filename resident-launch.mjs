import {readFile} from 'node:fs/promises';
import {parseResidentArgs} from './resident-args.mjs';
export {parseResidentArgs};

// Load the rules and controller only after selecting the table for this process.
export async function prepareResident(args){
 const cli=parseResidentArgs(args);
 const config=cli.configPath?JSON.parse(await readFile(cli.configPath,'utf8')):{};
 const sanma=cli.players===3;
 if(sanma){
  const winds=config.scheduledWinds??1;
  if(![1,2].includes(winds))throw Error('scheduledWinds 必须为 1（东风）或 2（半庄）');
  const layout=JSON.parse(await readFile(new URL('./sanma/layout.json',import.meta.url),'utf8'));
  if(layout.verified!==true||['self','right','opposite','left'].some(p=>layout.kita_boxes?.[p]?.length!==4))throw Error('三人场拔北区域标定不完整');
  process.env.TINGYUAN_SCHEDULED_WINDS=String(winds);
 }
 process.env.MAJSOUL_CONTROLLER_GAME=sanma?'sanma':'yonma';
 const {GAME}=await import('./game-rules.mjs');
 if(GAME.sanma!==sanma)throw Error('不能在同一运行进程内切换场次');
 const {runResident}=await import('./resident-core.mjs');
 return {runResident,options:{...config,briefPostMatch:cli.briefPostMatch,goldRoom:cli.goldRoom===true,jadeRoom:cli.jadeRoom===true,singleMatch:cli.singleMatch,shortOnly:cli.shortOnly===true,saveAllScreenshots:cli.saveAllScreenshots,startupArgs:args}};
}
export async function launchResident(args){
 const {runResident,options}=await prepareResident(args);
 return runResident(options);
}
