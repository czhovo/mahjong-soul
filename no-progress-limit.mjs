export function countNoProgress(owner){
 owner.noProgressCount=(owner.noProgressCount??0)+1;
 if(owner.noProgressCount>=3)throw Object.assign(Error('连续三次10秒未推进，听风执牌已停止'),{code:'NO_PROGRESS_LIMIT'});
}
