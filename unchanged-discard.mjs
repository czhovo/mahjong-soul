// Prove that the submitted discard is still pending using its own visible
// hand/effect. Unrelated historical recognition and button lists are not gates.
import {roundIdentity} from './round-boundary.mjs';
const melds=x=>x?.complete?x.groups.map(g=>[g.kind,g.tiles,g.calledIndex,g.fromRelative]):null;
const OWN_DISCARD_CONTROLS=new Set(['PASS','LIZHI','GANG','ANGANG','BUGANG','KITA','KYUSHU']);
function localDiscardStillPresent(decision,before,after,stableFrame,ownPrompt){
 const expected=decision.visibleHand;
 if(!after.hand?.complete||after.hand.rejected?.length||!Array.isArray(expected)||expected.length%3!==2)return false;
 const visible=after.hand.tiles.map(t=>t.tile);
 if(visible.join()!==expected.join()||!visible.includes(decision.output.response.split(' ')[1]))return false;
 if(after.selection?.verified||after.call_choices?.verified)return false;
 // Own-turn action buttons (e.g. LIZHI/ANGANG/BUGANG/GANG/KITA/PASS) do not block
 // direct tile discard; only refuse when a win button or opponent reaction is present.
 const controlKeys=Object.keys(after.controls??{});
 if(ownPrompt?!after.controls?.PASS:controlKeys.some(k=>!OWN_DISCARD_CONTROLS.has(k)))return false;
 const stable=stableFrame?.id!==after.id&&stableFrame?.id!==before.id&&stableFrame?.hand?.complete&&
   stableFrame.hand.tiles.map(t=>t.tile).join()===visible.join();
 const turn=after.round?.turn?.position;
 if(turn!=null&&turn!=='self')return false;
 // Reject positive evidence of progression, not missing or inconsistent old OCR.
 const a=roundIdentity(before),b=roundIdentity(after);
 if(a&&b&&JSON.stringify(a)!==JSON.stringify(b))return false;
 if(after.own_melds?.complete&&visible.length!==14-3*after.own_melds.groups.length)return false;
 const priorMelds=melds(before.own_melds),currentMelds=melds(after.own_melds);
 if(priorMelds&&currentMelds&&JSON.stringify(priorMelds)!==JSON.stringify(currentMelds))return false;
 const oldWall=before.round?.remaining?.value,newWall=after.round?.remaining?.value;
 if(Number.isInteger(oldWall)&&Number.isInteger(newWall)&&newWall<oldWall)return false;
 const old=before.rivers?.self,next=after.rivers?.self;
 if(old?.complete&&next?.complete&&next.tiles.length>old.tiles.length)return false;
 // Two stable current hands also handle a hover-raised original input tile.
 // Clicking an unselected/unfocused tile in Mahjong Soul lifts it purely vertically
 // (~34-48px) while keeping its horizontal slot identical; allow up to 2 vertically
 // lifted/dropped tiles so we retry cleanly instead of misreporting a river mismatch.
 const reference=stable?stableFrame:before;
 if(reference.hand?.tiles?.length!==visible.length)return false;
 let verticalShifts=0;
 for(let i=0;i<visible.length;i++){
  const x=reference.hand.tiles[i],y=after.hand.tiles[i];
  if(x.tile!==y.tile||!x.center||!y.center)return false;
  const height=x.corners?.length?Math.abs(x.corners[2][1]-x.corners[0][1]):40;
  const dx=Math.abs(x.center[0]-y.center[0]),dy=Math.abs(x.center[1]-y.center[1]);
  const tight=Math.max(2,height*.08);
  if(dx>Math.max(3,height*.12))return false;
  if(dy>tight){
   if(dy>Math.max(6,height*1.25))return false;
   verticalShifts++;
   if(verticalShifts>2)return false;
  }
 }
 return true;
}
export function unchangedDiscard(decision,before,after,{ownPrompt=false,stableFrame=null}={}){
 if(!/^PLAY ([WBT][0-9]|Z[1-7])$/.test(decision?.output?.response??'')||!after?.id||before.id===after.id)return false;
 return localDiscardStillPresent(decision,before,after,stableFrame,ownPrompt);
}
