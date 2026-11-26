import {GAME} from './game-rules.mjs';
import {roundIdentity} from './round-boundary.mjs';
import {canonicalMelds} from './meld-events.mjs';

const BUTTON_ACTIONS = new Set(['LIZHI', 'ANGANG', 'BUGANG', 'KITA']);

export function drawWindowKey(frame) {
  if (!frame?.hand?.complete) return null;
  const round = roundIdentity(frame);
  const hand = frame.hand.tiles.map(t => t.tile);
  const melds = frame.own_melds?.complete ? canonicalMelds(frame, 'self', frame.own_melds) : null;
  const remaining = frame.round?.remaining?.estimated
    ? frame.round.remaining.observedValue
    : frame.round?.remaining?.value ?? null;
  const kita = GAME.sanma ? (frame.kita?.self?.count ?? null) : null;
  return JSON.stringify([round, hand, melds, remaining, kita]);
}

export function hasActionButton(controls, kind) {
  if (!controls || typeof controls !== 'object') return false;
  if (kind === 'LIZHI') return Array.isArray(controls.LIZHI?.center);
  if (kind === 'ANGANG') return Array.isArray(controls.ANGANG?.center) || Array.isArray(controls.GANG?.center);
  if (kind === 'BUGANG') return Array.isArray(controls.BUGANG?.center) || Array.isArray(controls.GANG?.center);
  if (kind === 'HU' || kind === 'TSUMO') return Array.isArray(controls.TSUMO?.center) || Array.isArray(controls.HU?.center);
  if (kind === 'KITA') return Array.isArray(controls.KITA?.center);
  if (kind === 'PASS') return Array.isArray(controls.PASS?.center);
  return false;
}

export function missingControlsForValidact(validact, controls) {
  const missing = [];
  const seen = new Set();
  for (const raw of String(validact ?? '').split(',')) {
    const kind = raw.trim().split(/\s+/)[0];
    if (!kind || !BUTTON_ACTIONS.has(kind) || seen.has(kind)) continue;
    seen.add(kind);
    if (!hasActionButton(controls, kind)) missing.push(kind);
  }
  return missing;
}

export function legalPlayTilesFromValidact(validact, hand = [], {locked = false, draw = null} = {}) {
  const items = String(validact ?? '').split(',').map(a => a.trim()).filter(Boolean);
  const playAction = items.find(a => a.split(/\s+/)[0] === 'PLAY');
  if (playAction) {
    const listed = playAction.split(/\s+/).slice(1);
    if (listed.length) return listed.filter(t => hand.includes(t));
  }
  const base = locked ? (draw && hand.includes(draw) ? [draw] : []) : [...new Set(hand)];
  if (GAME.sanma) {
    const nonNorth = base.filter(t => t !== 'Z4');
    return nonNorth.length ? nonNorth : base;
  }
  return base;
}

// Accumulates any control buttons recognized across frames within the same own-draw decision window.
// Once recognized in any frame of this window, a button remains available for execution even if a
// later frame flickers; switching turn or round clears the cache immediately.
export class OwnDrawControlWindow {
  constructor() {
    this.key = null;
    this.controls = {};
    this.frameCount = 0;
  }
  reset() {
    this.key = null;
    this.controls = {};
    this.frameCount = 0;
  }
  begin(frame, controls = frame?.controls) {
    const key = drawWindowKey(frame);
    if (key !== this.key) {
      this.key = key;
      this.controls = {};
      this.frameCount = 0;
    }
    this.observeControls(controls);
    return this.controls;
  }
  observeControls(controls) {
    this.frameCount++;
    if (!controls || typeof controls !== 'object') return this.controls;
    for (const [k, v] of Object.entries(controls)) {
      if (v && Array.isArray(v.center)) {
        this.controls[k] = structuredClone(v);
      }
    }
    return this.controls;
  }
  hasButton(kind) {
    return hasActionButton(this.controls, kind);
  }
  mergedControls(baseControls = {}) {
    return {...(baseControls ?? {}), ...structuredClone(this.controls)};
  }
}

function bestRankedPlay(decision, legalPlayTiles) {
  const allowed = new Set(legalPlayTiles);
  const ranked = decision?.output?.decision_options?.ranked;
  if (Array.isArray(ranked)) {
    for (const row of ranked) {
      if (typeof row?.response !== 'string') continue;
      const parts = row.response.trim().split(/\s+/);
      if (parts[0] === 'PLAY' && parts.length === 2 && allowed.has(parts[1])) {
        return `PLAY ${parts[1]}`;
      }
    }
  }
  if (legalPlayTiles.length) return `PLAY ${legalPlayTiles[0]}`;
  return null;
}

/**
 * Resolve execution strategy for an own-draw decision using ONLY the controls accumulated
 * across the entire decision window (never requiring a fresh execution-moment button check).
 *
 * Returns:
 *  - `{ mode: 'direct' }` for PLAY / PASS
 *  - `{ mode: 'button', controls }` when the window saw the required button at least once
 *  - `{ mode: 'degrade_play', requested, actual, reason }` for LIZHI / ANGANG / BUGANG without button
 *  - `{ mode: 'auto_win', requested, reason }` for HU / TSUMO without button
 *  - `{ mode: 'auto_kita', requested, reason }` for KITA without button
 */
export function resolveOwnDrawExecution(decision, windowControls, {
  validact = decision?.input?.requests?.at(-1)?.validact ?? '',
  hand = decision?.visibleHand ?? [],
  locked = false,
  draw = null,
} = {}) {
  const requested = String(decision?.output?.response ?? '').trim();
  const parts = requested.split(/\s+/);
  const kind = parts[0];
  if (!BUTTON_ACTIONS.has(kind)) {
    return {mode: 'direct', requested};
  }
  if (hasActionButton(windowControls, kind)) {
    return {mode: 'button', requested, controls: structuredClone(windowControls)};
  }
  if (kind === 'KITA') {
    return {mode: 'auto_kita', requested, reason: '整个决策窗口未识别到拔北按钮，转为自动拔北'};
  }
  const legalPlayTiles = legalPlayTilesFromValidact(validact, hand, {locked, draw});
  if (kind === 'LIZHI') {
    const tile = parts[1];
    const actual = tile && legalPlayTiles.includes(tile)
      ? `PLAY ${tile}`
      : bestRankedPlay(decision, legalPlayTiles);
    if (!actual) throw Object.assign(Error('立直无按钮退化失败：缺少合法弃牌候选'), {code: 'DEGRADE_NO_LEGAL_PLAY'});
    return {mode: 'degrade_play', requested, actual, reason: '整个决策窗口未识别到立直按钮，退化为直接弃牌'};
  }
  if (kind === 'ANGANG' || kind === 'BUGANG') {
    const actual = bestRankedPlay(decision, legalPlayTiles);
    if (!actual) throw Object.assign(Error(`${kind} 无按钮退化失败：缺少合法弃牌候选`), {code: 'DEGRADE_NO_LEGAL_PLAY'});
    return {mode: 'degrade_play', requested, actual, reason: `整个决策窗口未识别到${kind === 'ANGANG' ? '暗杠' : '加杠'}按钮，退化为最优合法弃牌`};
  }
  return {mode: 'direct', requested};
}
