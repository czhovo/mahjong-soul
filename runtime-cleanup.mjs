// Every cleanup must run even when the checkpoint cannot be written.
export async function cleanupRuntime(steps){
 const errors=[];
 for(const step of steps){try{await step();}catch(error){errors.push(error);}}
 if(errors.length)throw new AggregateError(errors,`Runtime cleanup encountered errors: ${errors.map(e=>`${e.code?e.code+': ':''}${e.message}`).join('; ')}`);
}
