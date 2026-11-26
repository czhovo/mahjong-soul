// Fixed vertical click ratio (~92.2% of client height) hits the overlap core
// of BOTH resting (~94.6%) and hover-lifted (~90.0%) hand tiles, avoiding
// draw-drop animation or hover-lift Y drift while keeping the recognized X slot.
export const HAND_CLICK_Y_RATIO = 0.922;

export function fixedHandClickCenter(center, observation) {
  if (!Array.isArray(center) || center.length < 2) return center;
  const h = observation?.clientHeight;
  if (!Number.isFinite(h) || h <= 0) return [center[0], center[1]];
  return [center[0], Math.round(h * HAND_CLICK_Y_RATIO) + 31];
}

// Recognized hand locations are in screen order. The separated rightmost
// tile is the current draw; preserve exact red/ordinary tile identity.
export function discardTarget(locations, tile) {
  const matches=(locations??[]).filter(t=>t.tile===tile);
  if(!matches.length)return undefined;
  const ordered=[...(locations??[])].sort((a,b)=>a.center[0]-b.center[0]);
  const last=ordered.at(-1),previous=ordered.at(-2);
  if(last?.tile===tile && previous && last.center[0]-previous.center[0]>=80)return last;
  return matches[0];
}
