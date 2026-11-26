import {GAME} from './game-rules.mjs';
import {shapeWaits} from './tenpai-hint.mjs';

export const TILE_CODES = Object.freeze([
  ...['W', 'B', 'T'].flatMap(s => Array.from({length: 9}, (_, i) => s + (i + 1))),
  ...Array.from({length: 7}, (_, i) => 'Z' + (i + 1)),
]);

const ORPHAN_INDICES = Object.freeze([0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33]);
const GREEN_INDICES = new Set([19, 20, 21, 23, 25, 32]); // T2,T3,T4,T6,T8,Z6

export const normTile = t => typeof t === 'string' && /^[WBT]0$/.test(t) ? t[0] + '5' : t;
export const isRedFive = t => typeof t === 'string' && /^[WBT]0$/.test(t);
export const tileIndex = t => TILE_CODES.indexOf(normTile(typeof t === 'object' ? t?.tile : t));
export const indexToTile = i => TILE_CODES[i] ?? null;
const isTerminalOrHonor = i => i >= 27 || i % 9 === 0 || i % 9 === 8;

export function doraFromIndicator(indicator, sanma = GAME.sanma) {
  const n = normTile(indicator);
  const i = TILE_CODES.indexOf(n);
  if (i < 0) return null;
  if (i < 27) {
    const suit = Math.floor(i / 9), rank = i % 9;
    if (sanma && suit === 0) {
      if (rank === 0) return 'W9';
      if (rank === 8) return 'W1';
      return null;
    }
    return TILE_CODES[suit * 9 + ((rank + 1) % 9)];
  }
  if (i <= 30) return TILE_CODES[27 + ((i - 27 + 1) % 4)];
  return TILE_CODES[31 + ((i - 31 + 1) % 3)];
}

// Exact standard-hand shanten via recursive meld + taatsu search.
function standardShanten(counts, fixedMelds) {
  const c = counts.slice();
  const maxGroups = 4 - fixedMelds;
  let best = 8 - 2 * fixedMelds;

  function scanTaatsu(idx, melds, taatsu, hasPair) {
    while (idx < 34 && c[idx] === 0) idx++;
    const effectiveTaatsu = Math.min(taatsu, maxGroups - melds);
    const sh = 8 - 2 * fixedMelds - 2 * melds - effectiveTaatsu - (hasPair ? 1 : 0);
    if (sh < best) best = sh;
    if (idx >= 34 || melds + taatsu >= maxGroups) return;
    // Optimistic lower bound: remaining tiles can at best fill remaining group slots.
    const remSlots = maxGroups - melds - taatsu;
    if (8 - 2 * fixedMelds - 2 * melds - (taatsu + remSlots) - 1 >= best) return;

    if (c[idx] >= 2) {
      c[idx] -= 2;
      scanTaatsu(idx, melds, taatsu + 1, hasPair);
      c[idx] += 2;
    }
    if (idx < 27 && idx % 9 < 8 && c[idx + 1] > 0) {
      c[idx]--; c[idx + 1]--;
      scanTaatsu(idx, melds, taatsu + 1, hasPair);
      c[idx]++; c[idx + 1]++;
    }
    if (idx < 27 && idx % 9 < 7 && c[idx + 2] > 0) {
      c[idx]--; c[idx + 2]--;
      scanTaatsu(idx, melds, taatsu + 1, hasPair);
      c[idx]++; c[idx + 2]++;
    }
    scanTaatsu(idx + 1, melds, taatsu, hasPair);
  }

  function scanMelds(idx, melds, hasPair) {
    while (idx < 34 && c[idx] === 0) idx++;
    if (idx >= 34 || melds >= maxGroups) {
      scanTaatsu(0, melds, 0, hasPair);
      return;
    }
    if (c[idx] >= 3) {
      c[idx] -= 3;
      scanMelds(idx, melds + 1, hasPair);
      c[idx] += 3;
    }
    if (idx < 27 && idx % 9 < 7 && c[idx + 1] > 0 && c[idx + 2] > 0) {
      c[idx]--; c[idx + 1]--; c[idx + 2]--;
      scanMelds(idx, melds + 1, hasPair);
      c[idx]++; c[idx + 1]++; c[idx + 2]++;
    }
    scanMelds(idx + 1, melds, hasPair);
  }

  // Case 1: without extracting a dedicated pair.
  scanMelds(0, 0, false);
  // Case 2: try each available pair as the head.
  for (let i = 0; i < 34; i++) {
    if (c[i] >= 2) {
      c[i] -= 2;
      scanMelds(0, 0, true);
      c[i] += 2;
    }
  }
  return best;
}

export function computeShanten(handTiles, melds = [], {sanma = GAME.sanma} = {}) {
  const meldCount = Array.isArray(melds) ? melds.length : melds;
  if (!Array.isArray(handTiles) || !Number.isInteger(meldCount) || meldCount < 0 || meldCount > 4) return null;
  const maxConcealed = 14 - 3 * meldCount;
  if (handTiles.length > maxConcealed || handTiles.length < maxConcealed - 1) return null;

  const c = Array(34).fill(0);
  const owned = Array(34).fill(0);
  for (const t of handTiles) {
    const i = tileIndex(t);
    if (i < 0 || (sanma && i >= 1 && i <= 7)) return null;
    c[i]++; owned[i]++;
  }
  if (Array.isArray(melds)) {
    for (const m of melds) {
      for (const t of m.tiles ?? []) {
        const i = tileIndex(t);
        if (i < 0 || (sanma && i >= 1 && i <= 7)) return null;
        owned[i]++;
      }
    }
  }
  if (owned.some(n => n > 4)) return null;

  let best = standardShanten(c, meldCount);
  if (meldCount === 0) {
    // Seven pairs (4-of-a-kind counts as only one pair and one kind).
    let pairs = 0, kinds = 0;
    for (let i = 0; i < 34; i++) {
      if (c[i] >= 1) kinds++;
      if (c[i] >= 2) pairs++;
    }
    const chiitoi = 6 - pairs + Math.max(0, 7 - kinds);
    if (chiitoi < best) best = chiitoi;

    // Kokushi musou.
    let orphanKinds = 0, orphanPair = false;
    for (const i of ORPHAN_INDICES) {
      if (c[i] > 0) orphanKinds++;
      if (c[i] >= 2) orphanPair = true;
    }
    const kokushi = 13 - orphanKinds - (orphanPair ? 1 : 0);
    if (kokushi < best) best = kokushi;
  }

  // A 13-3m hand whose only mathematical wait is a 5th copy of a tile we already hold 4 of is not tenpai.
  if (best === 0 && handTiles.length === 13 - 3 * meldCount && Array.isArray(melds)) {
    const rawWaits = shapeWaits(handTiles, melds);
    const waits = rawWaits && sanma ? rawWaits.filter(w => !/^W[2-8]$/.test(w)) : rawWaits;
    if (!waits || waits.length === 0) best = 1;
  }
  return best;
}

function enumeratePartitions(c, start = 0, groups = []) {
  let i = start;
  while (i < 34 && c[i] === 0) i++;
  if (i >= 34) return [groups];
  const out = [];
  if (c[i] >= 3) {
    c[i] -= 3;
    out.push(...enumeratePartitions(c, i, [...groups, {t: i, trip: true, open: false, kong: false}]));
    c[i] += 3;
  }
  if (i < 27 && i % 9 < 7 && c[i + 1] > 0 && c[i + 2] > 0) {
    c[i]--; c[i + 1]--; c[i + 2]--;
    out.push(...enumeratePartitions(c, i, [...groups, {t: i, trip: false, open: false, kong: false}]));
    c[i]++; c[i + 1]++; c[i + 2]++;
  }
  return out;
}

function roundUp100(v) {
  return Math.ceil(v / 100) * 100;
}

function scorePayment(han, fu, dealer, yakumanUnits) {
  if (yakumanUnits > 0) return yakumanUnits * (dealer ? 48000 : 32000);
  if (han >= 13) return dealer ? 48000 : 32000;
  if (han >= 11) return dealer ? 36000 : 24000;
  if (han >= 8) return dealer ? 24000 : 16000;
  if (han >= 6) return dealer ? 18000 : 12000;
  if (han >= 5 || (han === 4 && fu >= 40) || (han === 3 && fu >= 70)) return dealer ? 12000 : 8000;
  const base = fu * (1 << (2 + han));
  return roundUp100(base * (dealer ? 6 : 4));
}

// Evaluate best closed-hand winning score for a single (winTile, mode, declared) combination.
function scoreClosedWin(hand13, ownMelds, winTile, {
  seat, wind, declared = false, tsumo = false, lastNormalTile = false, bonusHan = 0,
}) {
  const dealer = seat === 0;
  const fixed = ownMelds.map(m => ({
    t: Math.min(...m.tiles.map(tileIndex)),
    trip: m.kind !== 'CHI',
    open: m.kind !== 'ANGANG',
    kong: m.tiles.length === 4,
  }));
  const closed = fixed.every(g => !g.open);
  if (!closed) return {legal: false, payment: 0, totalHan: 0, naturalYakuman: 0};

  const c = Array(34).fill(0);
  const full = Array(34).fill(0);
  for (const t of [...hand13, winTile]) {
    const i = tileIndex(t);
    c[i]++; full[i]++;
  }
  for (const m of ownMelds) {
    for (const t of m.tiles) full[tileIndex(t)]++;
  }
  const w = tileIndex(winTile);
  const allIndices = [];
  for (let i = 0; i < 34; i++) if (full[i] > 0) allIndices.push(i);

  const suits = new Set(allIndices.filter(i => i < 27).map(i => Math.floor(i / 9)));
  const hasHonors = allIndices.some(i => i >= 27);
  const allSimples = allIndices.every(i => !isTerminalOrHonor(i));
  const allOutside = allIndices.every(isTerminalOrHonor);
  const flushHan = suits.size === 1 ? (hasHonors ? 3 : 6) : 0;

  let commonYakuman = 0;
  if (allIndices.every(i => i >= 27)) commonYakuman += 1; // 字一色
  if (allIndices.every(i => i < 27 && isTerminalOrHonor(i))) commonYakuman += 1; // 清老头
  if (allIndices.every(i => GREEN_INDICES.has(i))) commonYakuman += 1; // 绿一色
  if (ownMelds.length === 0 && suits.size === 1 && !hasHonors) {
    const base = [...suits][0] * 9;
    let chuuren = full[base] >= 3 && full[base + 8] >= 3;
    for (let k = 1; k < 8; k++) chuuren &&= full[base + k] >= 1;
    if (chuuren) {
      const before = full.slice();
      before[w]--;
      let pure = before[base] === 3 && before[base + 8] === 3;
      for (let k = 1; k < 8; k++) pure &&= before[base + k] === 1;
      commonYakuman += pure ? 2 : 1; // 纯正九莲宝灯 / 九莲宝灯
    }
  }

  let best = {legal: false, payment: 0, totalHan: 0, naturalYakuman: 0};
  const accept = (yakuHan, fu, naturalYakuman) => {
    // 偶然役（如海底摸月）不可将静态无役判为合法和牌，仅当静态役已成立时才加计偶然役番数。
    if (yakuHan <= 0 && naturalYakuman === 0) return;
    let h = yakuHan;
    if (lastNormalTile && naturalYakuman === 0) h += 1; // 海底摸月
    const totalHan = naturalYakuman > 0 ? 0 : h + bonusHan;
    const payment = scorePayment(totalHan, fu, dealer, naturalYakuman);
    if (!best.legal || payment > best.payment || (payment === best.payment && (naturalYakuman > best.naturalYakuman || totalHan > best.totalHan))) {
      best = {legal: true, payment, totalHan, naturalYakuman};
    }
  };

  // Special hands (kokushi / chiitoitsu) when no melds.
  if (ownMelds.length === 0) {
    if (ORPHAN_INDICES.every(i => c[i] > 0) && ORPHAN_INDICES.some(i => c[i] === 2)) {
      const before = c.slice();
      before[w]--;
      const thirteen = ORPHAN_INDICES.every(i => before[i] === 1);
      accept(0, 0, commonYakuman + (thirteen ? 2 : 1));
    }
    if (c.filter(n => n === 2).length === 7) {
      let han = 2 + (declared ? 1 : 0) + (tsumo ? 1 : 0) + (allSimples ? 1 : 0) + flushHan + (allOutside && hasHonors && suits.size > 0 ? 2 : 0);
      accept(han, 25, commonYakuman);
    }
  }

  // Standard 4-meld + 1-pair decompositions.
  for (let pair = 0; pair < 34; pair++) {
    if (c[pair] < 2) continue;
    c[pair] -= 2;
    const sets = enumeratePartitions(c);
    c[pair] += 2;
    for (const concealed of sets) {
      const gs = [...fixed, ...concealed];
      const placements = [];
      if (pair === w) placements.push(-1);
      concealed.forEach((g, k) => {
        if (g.trip ? g.t === w : (w >= g.t && w <= g.t + 2)) placements.push(fixed.length + k);
      });
      for (const pos of placements) {
        let han = (declared ? 1 : 0) + (tsumo ? 1 : 0) + (allSimples ? 1 : 0) + flushHan;
        let yakuman = commonYakuman;

        const trips = gs.filter(g => g.trip);
        const seqs = gs.filter(g => !g.trip);

        for (const g of trips) {
          if (g.t >= 31) han += 1; // 白发中
          if (Number.isInteger(seat) && g.t === 27 + seat) han += 1; // 自风
          if (Number.isInteger(wind) && g.t === 27 + wind) han += 1; // 场风
        }

        const dragons = trips.filter(g => g.t >= 31).length;
        const winds = trips.filter(g => g.t >= 27 && g.t <= 30).length;
        if (dragons === 3) yakuman += 1; // 大三元
        else if (dragons === 2 && pair >= 31) han += 2; // 小三元
        if (winds === 4) yakuman += 2; // 大四喜
        else if (winds === 3 && pair >= 27 && pair <= 30) yakuman += 1; // 小四喜

        const hiddenTrips = gs.filter((g, k) => g.trip && !g.open && !(!tsumo && k === pos)).length;
        if (hiddenTrips === 4) yakuman += (pos === -1 ? 2 : 1); // 四暗刻单骑 / 四暗刻
        else if (hiddenTrips === 3) han += 2; // 三暗刻

        const kans = gs.filter(g => g.kong).length;
        if (kans === 4) yakuman += 1; // 四杠子
        else if (kans === 3) han += 2; // 三杠子

        if (trips.length === 4) han += 2; // 对对和
        if (allOutside && hasHonors && suits.size > 0) han += 2; // 混老头

        // 一杯口 / 二杯口
        const seqCounts = new Map();
        for (const g of seqs) seqCounts.set(g.t, (seqCounts.get(g.t) ?? 0) + 1);
        const identicalPairs = [...seqCounts.values()].reduce((a, n) => a + Math.floor(n / 2), 0);
        if (identicalPairs >= 2) han += 3;
        else if (identicalPairs === 1) han += 1;

        // 三色同顺
        for (let n = 0; n < 7; n++) {
          if ([n, n + 9, n + 18].every(t => seqs.some(g => g.t === t))) { han += 2; break; }
        }
        // 三色同刻
        for (let n = 0; n < 9; n++) {
          if ([n, n + 9, n + 18].every(t => trips.some(g => g.t === t))) { han += 2; break; }
        }
        // 一气通贯
        for (let s = 0; s < 27; s += 9) {
          if ([s, s + 3, s + 6].every(t => seqs.some(g => g.t === t))) { han += 2; break; }
        }
        // 混全带幺九 / 纯全带幺九
        if (seqs.length > 0 && isTerminalOrHonor(pair) && gs.every(g => g.trip ? isTerminalOrHonor(g.t) : (g.t % 9 === 0 || g.t % 9 === 6))) {
          han += hasHonors ? 2 : 3;
        }

        // 平和
        const winGroup = pos >= 0 ? gs[pos] : null;
        const ryanmen = !!(winGroup && !winGroup.trip && (w === winGroup.t || w === winGroup.t + 2) &&
          !(winGroup.t % 9 === 0 && w === winGroup.t + 2) &&
          !(winGroup.t % 9 === 6 && w === winGroup.t));
        const pairValue = (pair >= 31 ? 1 : 0) + (Number.isInteger(seat) && pair === 27 + seat ? 1 : 0) + (Number.isInteger(wind) && pair === 27 + wind ? 1 : 0);
        const isPinfu = seqs.length === 4 && pairValue === 0 && ryanmen;
        if (isPinfu) han += 1;

        // Fu calculation
        let fu;
        if (isPinfu) {
          fu = tsumo ? 20 : 30;
        } else {
          fu = 20 + (tsumo ? 2 : 10);
          fu += pairValue * 2;
          if (pos === -1) fu += 2; // tanki
          else if (winGroup && !winGroup.trip && !ryanmen) fu += 2; // kanchan or penchan
          for (let k = 0; k < gs.length; k++) {
            const g = gs[k];
            if (!g.trip) continue;
            const openTrip = g.open || (!tsumo && k === pos);
            const term = isTerminalOrHonor(g.t);
            let mfu = g.kong ? 8 : 2;
            if (!openTrip) mfu *= 2;
            if (term) mfu *= 2;
            fu += mfu;
          }
          fu = Math.ceil(fu / 10) * 10;
        }

        accept(han, fu, yakuman);
      }
    }
  }
  return best;
}

/**
 * Evaluate the "默听役满" (dama yakuman / counted yakuman) riichi exclusion rule
 * for a single candidate riichi declaration tile `discardTile`.
 *
 * Returns `{ blocked: boolean, reason, legalDama, cappedDama, unlocked, increased }`.
 */
export function evaluateDamaRiichiCap(hand14, discardTile, ownMelds = [], {
  seat = null,
  wind = null,
  doraIndicators = [],
  visibleCounts = null,
  seenReds = null,
  ownDiscards = [],
  remaining = null,
  remainingExact = true,
  ownKitaCount = 0,
  sanma = GAME.sanma,
} = {}) {
  if (!Array.isArray(hand14) || !Array.isArray(ownMelds) || ownMelds.some(m => m.kind !== 'ANGANG')) {
    return {blocked: false, reason: 'not_closed'};
  }
  const h13 = hand14.slice();
  const di = h13.indexOf(discardTile);
  if (di < 0) return {blocked: false, reason: 'discard_missing'};
  h13.splice(di, 1);

  const rawWaits = shapeWaits(h13, ownMelds);
  const waits = rawWaits && sanma ? rawWaits.filter(w => !/^W[2-8]$/.test(w)) : rawWaits;
  if (!waits || waits.length === 0) return {blocked: false, reason: 'not_ready'};

  // If seat/wind are unknown and any wind tile is involved in hand/melds/waits,
  // avoid falsely certifying a cap because wind yakuhai/pinfu cannot be verified.
  const windsKnown = Number.isInteger(seat) && Number.isInteger(wind);
  if (!windsKnown) {
    const allPotential = [...h13, ...ownMelds.flatMap(m => m.tiles), ...waits];
    if (allPotential.some(t => /^Z[1-4]$/.test(normTile(t)))) {
      return {blocked: false, reason: 'winds_unknown'};
    }
  }

  // Visible counts fallback: at least our 14 tiles + own melds + dora indicators.
  const visible = visibleCounts ? visibleCounts.slice() : Array(34).fill(0);
  const redsSeen = seenReds ? new Set(seenReds) : new Set();
  if (!visibleCounts) {
    for (const t of [...hand14, ...ownMelds.flatMap(m => m.tiles), ...doraIndicators]) {
      const i = tileIndex(t);
      if (i >= 0) visible[i]++;
      if (isRedFive(t)) redsSeen.add(t[0]);
    }
    if (sanma && ownKitaCount > 0) visible[tileIndex('Z4')] += ownKitaCount;
  }

  const discardSet = new Set([...ownDiscards.map(normTile), normTile(discardTile)]);
  const furiten = waits.some(w => discardSet.has(w));
  const players = sanma ? 3 : 4;
  const ronPossible = !furiten && (remaining == null || remaining > 0);
  const tsumoPossible = remaining == null || remaining >= players;
  const onlyLastTsumo = remainingExact && tsumoPossible && Number.isInteger(remaining) && remaining === players;

  // Known dora tiles from indicators.
  const doraCounts = Array(34).fill(0);
  for (const ind of doraIndicators) {
    const d = doraFromIndicator(ind, sanma);
    const idx = d ? tileIndex(d) : -1;
    if (idx >= 0) doraCounts[idx]++;
  }
  const baseTiles = [...h13, ...ownMelds.flatMap(m => m.tiles)];
  let baseDoraHan = 0;
  for (const t of baseTiles) {
    const idx = tileIndex(t);
    if (idx >= 0) baseDoraHan += doraCounts[idx];
    if (isRedFive(t)) baseDoraHan += 1;
  }
  if (sanma && ownKitaCount > 0) {
    baseDoraHan += ownKitaCount * (1 + doraCounts[tileIndex('Z4')]);
  }

  let legalDama = 0, cappedDama = 0, unlocked = 0, increased = 0;
  for (const wait of waits) {
    const idx = tileIndex(wait);
    const copies = Math.max(0, 4 - (visible[idx] ?? 0));
    if (copies <= 0) continue;

    // Determine realizable ordinary vs red-5 variants for this wait tile.
    let ordinary = true, red = false;
    const suit = wait[0];
    if (idx < 27 && idx % 9 === 4 && !(sanma && suit === 'W')) {
      const knownRed = redsSeen.has(suit);
      const knownNormal = Math.max(0, (visible[idx] ?? 0) - (knownRed ? 1 : 0));
      const possibleNormal = Math.max(0, 3 - knownNormal);
      ordinary = possibleNormal > 0;
      red = !knownRed && copies > 0;
      if (!ordinary && !red) ordinary = true;
    }

    const variants = [];
    if (ordinary) variants.push(wait);
    if (red) variants.push(suit + '0');

    for (const winTile of variants) {
      const winBonus = baseDoraHan + doraCounts[idx] + (isRedFive(winTile) ? 1 : 0);
      const checkMethod = (tsumo, last) => {
        const dama = scoreClosedWin(h13, ownMelds, winTile, {
          seat, wind, declared: false, tsumo, lastNormalTile: last, bonusHan: winBonus,
        });
        const riichi = scoreClosedWin(h13, ownMelds, winTile, {
          seat, wind, declared: true, tsumo, lastNormalTile: last, bonusHan: winBonus,
        });
        if (dama.legal) {
          legalDama++;
          if (dama.naturalYakuman > 0 || dama.totalHan >= 13) cappedDama++;
        }
        if (riichi.legal && !dama.legal) unlocked++;
        if (riichi.payment > dama.payment) increased++;
      };
      if (ronPossible) checkMethod(false, false);
      if (tsumoPossible) checkMethod(true, onlyLastTsumo);
    }
  }

  const blocked = legalDama > 0 && cappedDama === legalDama && unlocked === 0 && increased === 0;
  return {blocked, reason: blocked ? 'dama_yakuman_capped' : 'allowed', legalDama, cappedDama, unlocked, increased};
}

/**
 * Determine whether discarding `discardTile` from closed `hand14` yields a
 * dama-yaku-less tenpai (no realizable wait has a static dama ron yaku,
 * excluding riichi / menzen tsumo / incidental yaku such as haitei/houtei).
 *
 * Used by endgame riichi restrictions so that a yaku-less tenpai is never
 * blocked from declaring riichi.
 */
export function isDamaYakuLess(hand14, discardTile, ownMelds = [], {
  seat = null,
  wind = null,
  visibleCounts = null,
  sanma = GAME.sanma,
} = {}) {
  if (!Array.isArray(hand14) || !Array.isArray(ownMelds) || ownMelds.some(m => m.kind !== 'ANGANG')) {
    return false;
  }
  const h13 = hand14.slice();
  const di = h13.indexOf(discardTile);
  if (di < 0) return false;
  h13.splice(di, 1);

  const rawWaits = shapeWaits(h13, ownMelds);
  const waits = rawWaits && sanma ? rawWaits.filter(w => !/^W[2-8]$/.test(w)) : rawWaits;
  if (!waits || waits.length === 0) return false;

  const liveWaits = Array.isArray(visibleCounts)
    ? waits.filter(w => (visibleCounts[tileIndex(w)] ?? 0) < 4)
    : waits;
  const checkWaits = liveWaits.length > 0 ? liveWaits : waits;

  if (!Number.isInteger(seat) || !Number.isInteger(wind)) {
    const windCounts = [0, 0, 0, 0];
    for (const t of [...h13, ...ownMelds.flatMap(m => m.tiles ?? [])]) {
      const idx = tileIndex(t);
      if (idx >= 27 && idx <= 30) windCounts[idx - 27]++;
    }
    for (let wi = 0; wi < 4; wi++) {
      if (windCounts[wi] >= 3 || (windCounts[wi] >= 2 && checkWaits.includes(`Z${wi + 1}`))) {
        return false;
      }
    }
  }

  for (const wait of checkWaits) {
    const damaRon = scoreClosedWin(h13, ownMelds, wait, {
      seat,
      wind,
      declared: false,
      tsumo: false,
      lastNormalTile: false,
      bonusHan: 0,
    });
    if (damaRon.legal) return false;
  }
  return true;
}
