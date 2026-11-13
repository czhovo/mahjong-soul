import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {launchResident} from './resident-launch.mjs';
export {parseResidentArgs} from './resident-args.mjs';
const main=process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href;
if(main)await launchResident(process.argv.slice(2)).catch(e=>{if(!e.reported)console.error(e.message);process.exitCode=1;});
// Existing imports of this module use the same controller as the command line.
export const {runResident,WaitingState,ResidentStatusLog,openingWaitMessage,pollDelay,selectGame,initialContext}=
 await import('./resident-core.mjs');
