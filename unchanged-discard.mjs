// Retry only a completed driver attempt whose complete public effect is absent.
// Never use this for calls, declarations, partial pixels, or changed game state.
import {roundIdentity} from './round-boundary.mjs';
const tiles=x=>x?.complete?x.tiles.map(t=>[t.tile,t.sideways??null]):null;
const melds=x=>x?.complete?x.groups.map(g=>[g.kind,g.tiles,g.calledIndex,g.fromRelative]):null;
function localDiscardStillPresent(decision,before,after,stableFrame){
 const expected=decision.visibleHand;
 if(!after.hand?.complete||after.hand.rejected?.length||!Array.isArray(expected)||expected.length%3!==2)return false;
 const visible=after.hand.tiles.map(t=>t.tile);
 if(visible.join()!==expected.join()||!visible.includes(decision.output.response.split(' ')[1]))return false;
 if(Object.keys(after.controls??{}).length||after.selection?.verified||after.call_choices?.verified)return false;
 const stable=stableFrame?.id!==after.id&&stableFrame?.id!==before.id&&stableFrame?.hand?.complete&&
   stableFrame.hand.tiles.map(t=>t.tile).join()===visible.join();
 const turn=after.round?.turn?.position;
 if(turn!=null&&turn!=='self')return false;
 // Reject positive evidence of progression, not missing or inconsistent old OCR.
 const a=roundIdentity(before),b=roundIdentity(after);
 if(a&&b&&JSON.stringify(a)!==JSON.stringify(b))return false;
 if(after.own_melds?.complete&&visible.length!==14-3*after.own_melds.groups.length)return false;
 const old=before.rivers?.self,next=after.rivers?.self;
 if(old?.complete&&next?.complete&&next.tiles.length>old.tiles.length)return false;
 // Two stable current hands also handle a hover-raised original input tile.
 const reference=stable?stableFrame:before;
 if(reference.hand?.tiles?.length!==visible.length)return false;
 for(let i=0;i<visible.length;i++){
  const x=reference.hand.tiles[i],y=after.hand.tiles[i];
  if(x.tile!==y.tile||!x.center||!y.center)return false;
  const height=x.corners?.length?Math.abs(x.corners[2][1]-x.corners[0][1]):40;
  if(Math.hypot(x.center[0]-y.center[0],x.center[1]-y.center[1])>Math.max(2,height*.08))return false;
 }
 return true;
}
export function unchangedDiscard(decision,before,after,{ownPrompt=false,localOnly=false,stableFrame=null}={}){
 if(!/^PLAY ([WBT][0-9]|Z[1-7])$/.test(decision?.output?.response??'')||!after?.id||before.id===after.id)return false;
 if(localOnly&&!ownPrompt)return localDiscardStillPresent(decision,before,after,stableFrame);
 if(!before.hand?.complete||!after.hand?.complete)return false;
 const stable=localOnly&&stableFrame?.id!==after.id&&stableFrame?.id!==before.id&&stableFrame?.hand?.complete&&
   stableFrame.hand.tiles.map(t=>t.tile).join()===after.hand.tiles.map(t=>t.tile).join()&&
   after.own_melds?.complete&&after.hand.tiles.length===14-3*after.own_melds.groups.length;
 if(after.round?.turn?.position!=='self'&&!(stable&&after.round?.turn?.position==null))return false;
 if(before.hand.tiles.map(t=>t.tile).join()!==after.hand.tiles.map(t=>t.tile).join())return false;
 if(decision.visibleHand.join()!==before.hand.tiles.map(t=>t.tile).join())return false;
 // A departing/raised tile still decodes to the same name during animation.
 // Require stable tile geometry, not merely an unchanged list of tile codes.
 for(let i=0;i<before.hand.tiles.length;i++){
  const a=(stable?stableFrame:before).hand.tiles[i],b=after.hand.tiles[i];
  if(!a.center||!b.center)return false;
  const height=a.corners?.length?Math.abs(a.corners[2][1]-a.corners[0][1]):40;
  const tolerance=Math.max(2,height*.08);
  if(Math.hypot(a.center[0]-b.center[0],a.center[1]-b.center[1])>tolerance)return false;
 }
 const ownPromptKeys=f=>{const keys=Object.keys(f.controls??{});return keys.length===2&&keys.includes('GANG')&&keys.includes('PASS')&&f.hand.tiles.length===14-3*(f.own_melds?.groups?.length??0);};
 if(ownPrompt){if(!ownPromptKeys(before)||!ownPromptKeys(after))return false;}
 else if(Object.keys(before.controls??{}).length||Object.keys(after.controls??{}).length)return false;
 const a=roundIdentity(before),b=roundIdentity(after);
 if(!a||!b||JSON.stringify(a)!==JSON.stringify(b))return false;
 if(!Number.isInteger(before.round.remaining?.value)||before.round.remaining.value!==after.round.remaining?.value||before.round.counters.riichi_sticks!==after.round.counters.riichi_sticks)return false;
 for(const p of localOnly?['self']:['self','right','opposite','left']){
  const old=tiles(before.rivers?.[p]),next=tiles(after.rivers?.[p]);
  if(!old)return false;
  if(!next&&localOnly){
   // A missing old river face does not invalidate an unchanged, stationary
   // full hand. Reject any visible new slot, changed tile or extra outline.
   const river=after.rivers?.[p];
   if(!river||river.face_count>old.length)return false;
   for(const t of river.tiles??[]){
    if(!Number.isInteger(t.row)||!Number.isInteger(t.column))return false;
    const slot=t.row*6+t.column;
    if(!old[slot]||old[slot][0]!==t.tile)return false;
   }
  }else if(!next||JSON.stringify(old)!==JSON.stringify(next))return false;
  const ma=melds(p==='self'?before.own_melds:before.opponent_melds?.[p]);
  const mb=melds(p==='self'?after.own_melds:after.opponent_melds?.[p]);
  if(!ma||!mb||JSON.stringify(ma)!==JSON.stringify(mb))return false;
 }
 if(localOnly)return true;
 const da=tiles(before.dora),db=tiles(after.dora);
 return !!da&&!!db&&JSON.stringify(da)===JSON.stringify(db);
}
