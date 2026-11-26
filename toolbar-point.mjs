import {readFileSync} from 'node:fs';
const layout=JSON.parse(readFileSync(new URL('./toolbar-points.json',import.meta.url),'utf8'));
export function toolbarPoint(frame,key){
 const [x,y]=layout[key];
 return [Math.round(1+(x-1)*(frame.clientWidth??1920)/layout.width),
         Math.round(31+(y-31)*(frame.clientHeight??1080)/layout.height)];
}
