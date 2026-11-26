import {mkdir, writeFile, rename, access} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';

export function actionTimeoutMs(action) {
  if (action === 'startup_focus') return 6000;
  if (action === 'riichi_discard' || action === 'call_choice' || action === 'double_click_500') return 4000;
  return 2500;
}

// Validate coordinates/freshness and construct a single-line TSV command for
// direct stdin pipe delivery (zero disk queue I/O).
export function buildClickRequest(observation, target, maxAgeMs = 1500) {
  const {capturedAt, clientWidth, clientHeight, screenshotId} = observation;
  const now = Date.now(), ageMs = now - capturedAt;
  if (!Number.isFinite(capturedAt) || ageMs > maxAgeMs || capturedAt > now)
    throw Object.assign(Error('Stale observation'), {code: 'STALE_OBSERVATION', inputNotSent: true, ageMs, maxAgeMs});
  if (!screenshotId || target.screenshotId !== screenshotId)
    throw Object.assign(Error('Target belongs to another observation'), {inputNotSent: true});
  for (const value of [clientWidth, clientHeight, target.x, target.y]) {
    if (!Number.isInteger(value)) throw Object.assign(Error('Expected integer client coordinates'), {inputNotSent: true});
  }
  if (clientWidth <= 0 || clientHeight <= 0 || target.x < 0 || target.y < 0 || target.x >= clientWidth || target.y >= clientHeight)
    throw Object.assign(Error('Out of bounds'), {inputNotSent: true});
  const follow = target.followUp;
  if (follow && (!Number.isInteger(follow.x) || !Number.isInteger(follow.y) || follow.x < 0 || follow.y < 0 || follow.x >= clientWidth || follow.y >= clientHeight))
    throw Object.assign(Error('Invalid follow-up coordinates'), {inputNotSent: true});
  if (follow && (target.modalConfirm || target.doubleClick500))
    throw Object.assign(Error('Follow-up is only supported for ordinary clicks'), {inputNotSent: true});

  const id = randomUUID();
  const expires = Math.floor(Date.now() / 1000) + 4;
  // Preserve exact click/focus semantics:
  //  - tile / background discards -> direct background client click (no WM_ACTIVATE)
  //  - ui / toggle / modal_confirm / retry / paired -> silent background WM_ACTIVATE click
  const focusClick = target.targetKind === 'ui' || target.targetKind === 'toggle';
  const action = follow
    ? (target.targetKind === 'ui_then_tile' ? 'riichi_discard' : 'call_choice')
    : target.modalConfirm
      ? 'modal_confirm'
      : target.doubleClick500
        ? 'double_click_500'
        : target.targetKind === 'retry'
          ? 'retry_click'
          : focusClick
            ? 'ui_click'
            : 'click';
  const line = [id, expires, clientWidth, clientHeight, action, target.x, target.y, ...(follow ? [follow.x, follow.y] : [])].join('\t');
  return {
    id,
    action,
    line,
    timeoutMs: actionTimeoutMs(action),
    status: 'ready',
    requiresVisualConfirmation: true,
  };
}

// Legacy file-queue helper retained for compatibility with --once or isolated tests.
export async function enqueueClick(rootDirectory, observation, target, maxAgeMs = 1500) {
  const req = buildClickRequest(observation, target, maxAgeMs);
  const directory = join(rootDirectory, 'queue');
  await mkdir(directory, {recursive: true});
  for (const name of ['request.tsv', 'processing.tsv']) {
    try { await access(`${directory}/${name}`); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw Error('Previous action is still pending');
  }
  const temporary = `${directory}/${req.id}.tmp`;
  await writeFile(temporary, req.line + '\n', {encoding: 'utf8', flag: 'wx'});
  await rename(temporary, `${directory}/request.tsv`);
  return {id: req.id, action: req.action, line: req.line, timeoutMs: req.timeoutMs, status: 'queued', requiresVisualConfirmation: true};
}
