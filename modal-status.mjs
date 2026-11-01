export function modalStatus(event){
 if(event.kind!=='modal_resolved')return null;
 const text=event.text?.replace(/[\x00-\x1f\x7f-\x9f]/g,' ').replace(/\s+/g,' ').trim();
 return `已处理异常：${text||'正文未能可靠识别'}`;
}
