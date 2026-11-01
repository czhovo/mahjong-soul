import {verifyEngineBuild,DEFAULT_EXECUTABLE} from './engine-builds.mjs';
import {checkRecognition,checkDecision} from './startup-checks.mjs';
import {DEFAULT_PYTHON} from './runtime-paths.mjs';
import {AhkDriver} from './ahk-driver.mjs';
import {fileURLToPath} from 'node:url';
import {mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const root=fileURLToPath(new URL('./',import.meta.url));
if(process.platform!=='win32')throw Error('Windows x64 is required');
if(Number(process.versions.node.split('.')[0])<22)throw Error('Node.js 22+ is required');
execFileSync(DEFAULT_PYTHON,['-X','utf8','-c','import cv2,numpy,PIL,lz4,UnityPy; from rapidocr_onnxruntime import RapidOCR; assert hasattr(cv2,"aruco"); RapidOCR(intra_op_num_threads=1,inter_op_num_threads=1); print("Python dependencies / OCR: Ready")'],{stdio:'inherit',windowsHide:true});
const captureReady=execFileSync(DEFAULT_PYTHON,['-u','-X','utf8',fileURLToPath(new URL('./capture-worker.py',import.meta.url))],{input:'',encoding:'utf8',timeout:30000,windowsHide:true});
if(JSON.parse(captureReady.trim()).type!=='ready')throw Error('Capture worker did not initialize');
const windows=JSON.parse(execFileSync(DEFAULT_PYTHON,['-X','utf8',fileURLToPath(new URL('./find-game-window.py',import.meta.url))],{encoding:'utf8',timeout:30000,windowsHide:true}));
console.log(`Capture / window discovery: Ready (${windows.length} compatible windows, no capture or click requested)`);
const engine=await verifyEngineBuild(DEFAULT_EXECUTABLE);
console.log(`Engine SHA-256: Ready (${engine.version}, ${engine.reducedVersion})`);
let t=performance.now();
const recognition=await checkRecognition();
console.log(`recognize v4: Ready ${((performance.now()-t)/1000).toFixed(3)}秒 (${Object.keys(recognition.checked).join(', ')})`);
await mkdir(new URL('./test-evidence/doctor/',import.meta.url),{recursive:true});
const result=await checkDecision({engine,directory:fileURLToPath(new URL('./test-evidence/doctor/',import.meta.url))});
for(const entry of result.warmedVersions)console.log(`v70 ${entry.searchSeconds}s: Ready (${entry.response}, off=${entry.off}, p_ron=${entry.pRon})`);
// Starts and shuts down the real output worker without submitting any input.
const driver=new AhkDriver(root);
try{await driver.start();console.log('AHK worker: Ready (no clicks sent)');}finally{await driver.close();}
console.log('Offline checks passed. The live startup additionally checks the actual game window and AHK title click.');
