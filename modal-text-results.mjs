const jobs=new Map();
export function modalTextResult(id){
 if(!jobs.has(id)){
  let resolve;const promise=new Promise(r=>resolve=r);jobs.set(id,{promise,resolve});
 }
 return jobs.get(id).promise;
}
export function deliverModalText(id,result){
 modalTextResult(id);jobs.get(id).resolve(result);
 while(jobs.size>128){const first=jobs.keys().next().value;jobs.get(first).resolve({});jobs.delete(first);}
}
