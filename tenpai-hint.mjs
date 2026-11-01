// Shape waits only: no hidden tiles, yaku or furiten claims.
const names=[...['W','B','T'].flatMap(s=>Array.from({length:9},(_,i)=>s+(i+1))),...Array.from({length:7},(_,i)=>'Z'+(i+1))];
const index=t=>names.indexOf(/^[WBT]0$/.test(t)?t[0]+'5':t);
function groups(c){
 const i=c.findIndex(n=>n>0);if(i<0)return true;
 if(c[i]>=3){c[i]-=3;const ok=groups(c);c[i]+=3;if(ok)return true;}
 if(i<27&&i%9<7&&c[i+1]&&c[i+2]){c[i]--;c[i+1]--;c[i+2]--;const ok=groups(c);c[i]++;c[i+1]++;c[i+2]++;if(ok)return true;}
 return false;
}
function winning(c,melds){
 if(!melds){
  if(c.filter(n=>n===2).length===7)return true;
  const terminals=[0,8,9,17,18,26,27,28,29,30,31,32,33];
  if(terminals.every(i=>c[i]>0)&&terminals.some(i=>c[i]===2))return true;
 }
 for(let i=0;i<34;i++)if(c[i]>=2){c[i]-=2;const ok=groups(c);c[i]+=2;if(ok)return true;}
 return false;
}
export function shapeWaits(hand,melds=[]){
 if(!Array.isArray(hand)||!Array.isArray(melds)||melds.length>4||hand.length!==13-3*melds.length)return null;
 const c=Array(34).fill(0),owned=Array(34).fill(0);
 for(const t of hand){const i=index(t);if(i<0)return null;c[i]++;owned[i]++;}
 for(const m of melds){if(!Array.isArray(m.tiles)||!['CHI','PENG','GANG','ANGANG','BUGANG'].includes(m.kind)||m.tiles.length!==(['GANG','ANGANG','BUGANG'].includes(m.kind)?4:3))return null;
  for(const t of m.tiles){const i=index(t);if(i<0)return null;owned[i]++;}}
 if(owned.some(n=>n>4))return null;
 const waits=[];
 for(let i=0;i<34;i++)if(owned[i]<4){c[i]++;if(winning(c,melds.length))waits.push(names[i]);c[i]--;}
 return waits;
}
