export function countNoProgress(owner,seconds=10){
 owner.noProgressCount=(owner.noProgressCount??0)+1;
 if(owner.noProgressCount>=3)throw Object.assign(Error(`连续三次${seconds}秒未推进，听风执牌已停止`),{code:'NO_PROGRESS_LIMIT'});
}
