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
