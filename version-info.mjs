import {readFileSync} from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('./versions.json', import.meta.url), 'utf8'));

export const VERSIONS = Object.freeze({
  interface: String(manifest.interface),
  tingfeng: String(manifest.tingfeng),
  tingyuan: String(manifest.tingyuan),
  recognize: String(manifest.recognize),
  execute: String(manifest.execute),
});
