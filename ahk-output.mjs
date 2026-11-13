import {mkdir, writeFile, rename, access} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';

// Publish only after a fresh observation. Input acknowledgement is not game success.
export async function enqueueClick(rootDirectory, observation, target, maxAgeMs=1500) {
  // Accept the interface root, never a caller-selected queue destination.
  const directory=join(rootDirectory,'queue');
  const {capturedAt, clientWidth, clientHeight, screenshotId}=observation;
  const now=Date.now(),ageMs=now-capturedAt;
  if(!Number.isFinite(capturedAt)||ageMs>maxAgeMs||capturedAt>now)
    throw Object.assign(Error('Stale observation'),{code:'STALE_OBSERVATION',inputNotSent:true,ageMs,maxAgeMs});
  if(!screenshotId||target.screenshotId!==screenshotId)throw Error('Target belongs to another observation');
  for(const value of [clientWidth,clientHeight,target.x,target.y])if(!Number.isInteger(value))throw Error('Expected integer client coordinates');
  if(clientWidth<=0||clientHeight<=0||target.x<0||target.y<0||target.x>=clientWidth||target.y>=clientHeight)throw Error('Out of bounds');
  const follow=target.followUp;
  if(follow&&(!Number.isInteger(follow.x)||!Number.isInteger(follow.y)||follow.x<0||follow.y<0||follow.x>=clientWidth||follow.y>=clientHeight))throw Error('Invalid follow-up coordinates');
  if(follow&&(target.modalConfirm||target.doubleClick500))throw Error('Follow-up is only supported for ordinary clicks');
  await mkdir(directory,{recursive:true});
  for(const name of ['request.tsv','processing.tsv']) {
    try {await access(`${directory}/${name}`);}catch(error){if(error.code==='ENOENT')continue;throw error;}
    throw Error('Previous action is still pending');
  }
  const id=randomUUID();
  const expires=Math.floor(Date.now()/1000)+3;
  const line=[id,expires,clientWidth,clientHeight,follow?'call_choice':target.modalConfirm?'modal_confirm':target.doubleClick500?'double_click_500':'click',target.x,target.y,...(follow?[follow.x,follow.y]:[])].join('\t');
  const temporary=`${directory}/${id}.tmp`;
  await writeFile(temporary,line+'\n',{encoding:'utf8',flag:'wx'});
  await rename(temporary,`${directory}/request.tsv`);
  return {id,status:'queued',requiresVisualConfirmation:true};
}
