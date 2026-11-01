import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const localPython=fileURLToPath(new URL('./.venv/Scripts/python.exe',import.meta.url));
export const DEFAULT_PYTHON=process.env.TINGFENG_PYTHON||(existsSync(localPython)?localPython:'python');
