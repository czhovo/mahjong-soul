// Omit only UI screenshot state objects. Protocol request.state strings are
// authoritative history and must survive checkpoint persistence.
export function checkpointReplacer(key,value){
 return key==='state'&&value!==null&&typeof value==='object'?undefined:value;
}
