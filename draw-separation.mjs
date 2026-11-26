// Adaptive check for an independently separated drawn tile on the right side of the hand.
// Uses median inter-tile pitch for >=3 tiles, and gracefully handles 4-meld bare tanki (2 tiles)
// using tile corner widths or prior-frame pitches instead of failing on an empty pitch array
// or relying on hard-coded pixel constants that break on smaller windows.
export function hasSeparatedDraw(handTiles, {priorTiles = null, factor = 1.18} = {}) {
  if (!Array.isArray(handTiles) || handTiles.length < 2) return false;
  const last = handTiles.at(-1), prev = handTiles.at(-2);
  if (!Number.isFinite(last?.center?.[0]) || !Number.isFinite(prev?.center?.[0])) return false;
  const gap = last.center[0] - prev.center[0];
  if (gap <= 0) return false;

  const collectPitches = tiles => Array.isArray(tiles) && tiles.length >= 3
    ? tiles.slice(1, -1)
        .map((t, i) => t?.center?.[0] - tiles[i]?.center?.[0])
        .filter(v => Number.isFinite(v) && v > 0)
        .sort((a, b) => a - b)
    : [];

  const pitches = collectPitches(handTiles);
  const priorPitches = pitches.length ? [] : collectPitches(priorTiles);
  const ref = pitches.length ? pitches : priorPitches;
  if (ref.length) {
    const pitch = ref[Math.floor(ref.length / 2)];
    return gap >= pitch * factor;
  }

  // 4-meld bare tanki (2 tiles in hand): derive tile width from corner boxes when available.
  const widths = handTiles
    .map(t => {
      if (!Array.isArray(t?.corners) || t.corners.length < 2) return null;
      const xs = t.corners.map(c => c?.[0]).filter(Number.isFinite);
      return xs.length >= 2 ? Math.max(...xs) - Math.min(...xs) : null;
    })
    .filter(w => Number.isFinite(w) && w > 0);
  if (widths.length) {
    const width = widths.reduce((a, b) => a + b, 0) / widths.length;
    return gap >= width * factor;
  }
  // Minimal 2-tile test/synthetic observation without corners: require positive non-overlapping gap.
  return gap >= 20;
}
