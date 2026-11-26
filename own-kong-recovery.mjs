import {roundIdentity} from './round-boundary.mjs';
const norm=t=>t?.replace(/0$/,'5');
// Recovery evidence, not confirmation of an AHK input: combine the known
// requested kong with newly exposed matching faces and concealed-hand removal.
export function recoverOwnKong(pending,frame){
 const [kind,tile]=pending.decision.output.response.split(' '),before=pending.before;
 if(kind!=='ANGANG'||frame.own_melds?.complete||!before.own_melds?.complete||frame.meld_rejected?.length)return frame;
 if(!roundIdentity(frame)||JSON.stringify(roundIdentity(before))!==JSON.stringify(roundIdentity(frame)))return frame;
 const previous=before.hand.tiles.map(t=>t.tile),four=previous.filter(t=>norm(t)===norm(tile));
 if(four.length!==4||!(frame.hand?.complete||frame.hand?.outline_verified&&!frame.hand?.rejected?.length))return frame;
 const oldFaces=before.meld_faces??[],faces=[...(frame.meld_faces??[])];
 for(const old of oldFaces){const i=faces.findIndex(t=>t.tile===old.tile&&Math.hypot(t.center[0]-old.center[0],t.center[1]-old.center[1])<8);if(i<0)return frame;faces.splice(i,1);}
 if(faces.length!==2||faces.some(t=>norm(t.tile)!==norm(tile)||!t.color?.verified))return frame;
 const count=before.own_melds.groups.length+1,hand=frame.hand.tiles.map(t=>t.tile);
 if(![13-3*count,14-3*count].includes(hand.length)||hand.some(t=>norm(t)===norm(tile)))return frame;
 const base=previous.filter(t=>norm(t)!==norm(tile)),rest=[...hand];
 let missing=0;for(const t of base){const i=rest.indexOf(t);if(i<0)missing++;else rest.splice(i,1);}
 const a=before.rivers?.self?.tiles??[],b=frame.rivers?.self?.tiles??[];
 if(a.some((t,i)=>t.tile!==b[i]?.tile)||missing>Math.max(0,b.length-a.length)||rest.length>missing+1)return frame;
 const out=structuredClone(frame);
 out.hand={...out.hand,complete:true,meld_count:count,phase:hand.length===14-3*count?'discard':'waiting'};
 out.own_melds={complete:true,groups:[...before.own_melds.groups,{kind:'ANGANG',tiles:four,calledIndex:null,fromRelative:null,centers:faces.map(t=>t.center)}],
  estimated:true,reason:'known requested concealed kong, two matching visible faces, four tiles removed from hand'};
 return out;
}
