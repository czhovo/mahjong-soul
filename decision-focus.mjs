// UI buttons now execute silently in the background via WM_ACTIVATE(WA_ACTIVE)
// inside output.ahk; no foreground focus acquisition is needed during search.
export function holdDecisionFocus(_windowId,signal){
  signal?.throwIfAborted();
  return {ready:Promise.resolve(),async release(){}};
}
