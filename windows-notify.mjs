import {spawn} from 'node:child_process';
import {GAME} from './game-rules.mjs';
import {actionName} from './terminal-log.mjs';

const POWERSHELL_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const TOAST_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
const WINDS = ['东', '南', '西', '北'];
const YAKUMAN_LABELS = ['役满', '两倍役满', '三倍役满', '四倍役满', '五倍役满', '六倍役满'];

export function xmlEscape(text = '') {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function psSingleQuote(text = '') {
  return `'${String(text ?? '').replaceAll("'", "''")}'`;
}

function normalizeBodyLines(body = '', bodyLines = null) {
  const raw = Array.isArray(bodyLines)
    ? bodyLines
    : String(body ?? '').split(/\r?\n/);
  return raw
    .map(line => String(line ?? '').replace(/[\r\n]+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 4)
    .map(line => line.slice(0, 180));
}

export function buildToastXml({title, body = '', bodyLines = null}) {
  const safeTitle = String(title ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 120);
  const lines = normalizeBodyLines(body, bodyLines);
  const nodes = [
    `<text>${xmlEscape(safeTitle)}</text>`,
    ...lines.map(line => `<text>${xmlEscape(line)}</text>`),
  ].join('');
  return `<toast><visual><binding template="ToastGeneric">${nodes}</binding></visual></toast>`;
}

export function buildToastPowerShellScript({title, body = '', bodyLines = null, gameHwnd = 0, dryRun = false}) {
  const safeTitle = String(title ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 120);
  const lines = normalizeBodyLines(body, bodyLines);
  const safeBody = lines.join('\n').slice(0, 300);
  const xml = buildToastXml({title: safeTitle, bodyLines: lines});
  const hwndNum = Number.isFinite(Number(gameHwnd)) ? Math.max(0, Math.trunc(Number(gameHwnd))) : 0;
  const scriptLines = [
    '$ErrorActionPreference = "Stop"',
    `$gameHwnd = [Int64]${hwndNum}`,
    'if ($gameHwnd -gt 0) {',
    '  try {',
    '    Add-Type -Namespace Win32Notify -Name Native -MemberDefinition \'[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();\' -ErrorAction SilentlyContinue | Out-Null',
    '    $fg = [Win32Notify.Native]::GetForegroundWindow().ToInt64()',
    '    if ($fg -eq $gameHwnd) { exit 0 }',
    '  } catch {}',
    '}',
    `$title = ${psSingleQuote(safeTitle)}`,
    `$body = ${psSingleQuote(safeBody)}`,
    `$xmlText = ${psSingleQuote(xml)}`,
    '$sent = $false',
    'try {',
    '  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '  $doc.LoadXml($xmlText)',
    '  $toast = New-Object Windows.UI.Notifications.ToastNotification $doc',
    `  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psSingleQuote(TOAST_APP_ID)})`,
    dryRun
      ? '  Write-Output ("DRY_RUN_OK:" + $notifier.Setting); $sent = $true'
      : '  if ($notifier.Setting -eq "Enabled") { $notifier.Show($toast); $sent = $true }',
    '} catch {}',
    'if (-not $sent) {',
    dryRun ? '  Write-Output "DRY_RUN_FALLBACK"; exit 0' : '  try {',
    ...(dryRun ? [] : [
      '    Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      '    Add-Type -AssemblyName System.Drawing | Out-Null',
      '    $icon = New-Object System.Windows.Forms.NotifyIcon',
      '    $icon.Icon = [System.Drawing.SystemIcons]::Information',
      '    $icon.Visible = $true',
      '    $icon.ShowBalloonTip(4000, $title, $body, [System.Windows.Forms.ToolTipIcon]::Info)',
      '    Start-Sleep -Milliseconds 4200',
      '    $icon.Dispose()',
      '  } catch {}',
    ]),
    '}',
  ];
  return scriptLines.join('\n');
}

export function buildToastWorkerScript() {
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'try {',
    '  Add-Type -Namespace Win32Notify -Name Native -MemberDefinition \'[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();\' -ErrorAction SilentlyContinue | Out-Null',
    '} catch {}',
    '$notifier = $null',
    'try {',
    '  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    `  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psSingleQuote(TOAST_APP_ID)})`,
    '} catch {}',
    'function Escape-Xml([string]$s) {',
    '  if ($null -eq $s) { return "" }',
    '  return $s.Replace("&","&amp;").Replace("<","&lt;").Replace(">","&gt;").Replace(\'"\',"&quot;").Replace("\'","&apos;")',
    '}',
    'while ($null -ne ($line = [Console]::In.ReadLine())) {',
    '  if ([string]::IsNullOrWhiteSpace($line)) { continue }',
    '  try {',
    '    $msg = $line | ConvertFrom-Json',
    '    $hwnd = [Int64]$msg.gameHwnd',
    '    if ($hwnd -gt 0 -and $msg.dryRun -ne $true) {',
    '      try {',
    '        if ([Win32Notify.Native]::GetForegroundWindow().ToInt64() -eq $hwnd) { continue }',
    '      } catch {}',
    '    }',
    '    $title = [string]$msg.title',
    '    $lines = @()',
    '    if ($null -ne $msg.bodyLines) {',
    '      foreach ($item in $msg.bodyLines) {',
    '        if (-not [string]::IsNullOrWhiteSpace([string]$item)) { $lines += [string]$item }',
    '      }',
    '    } elseif (-not [string]::IsNullOrWhiteSpace([string]$msg.body)) {',
    '      $lines += [string]$msg.body',
    '    }',
    '    $xmlNodes = "<text>" + (Escape-Xml $title) + "</text>"',
    '    foreach ($l in $lines) { $xmlNodes += "<text>" + (Escape-Xml $l) + "</text>" }',
    '    $xml = \'<toast><visual><binding template="ToastGeneric">\' + $xmlNodes + \'</binding></visual></toast>\'',
    '    if ($msg.dryRun -eq $true) {',
    '      if ($null -ne $notifier) { [Console]::Out.WriteLine("DRY_RUN_OK:" + $notifier.Setting + "|" + $xml) }',
    '      else { [Console]::Out.WriteLine("DRY_RUN_FALLBACK|" + $xml) }',
    '      [Console]::Out.Flush()',
    '      continue',
    '    }',
    '    $sent = $false',
    '    if ($null -ne $notifier) {',
    '      try {',
    '        if ($notifier.Setting -eq "Enabled") {',
    '          $doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '          $doc.LoadXml($xml)',
    '          $toast = New-Object Windows.UI.Notifications.ToastNotification $doc',
    '          $notifier.Show($toast)',
    '          $sent = $true',
    '        }',
    '      } catch {}',
    '    }',
    '    if (-not $sent) {',
    '      try {',
    '        Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '        Add-Type -AssemblyName System.Drawing | Out-Null',
    '        $icon = New-Object System.Windows.Forms.NotifyIcon',
    '        $icon.Icon = [System.Drawing.SystemIcons]::Information',
    '        $icon.Visible = $true',
    '        $icon.ShowBalloonTip(4000, $title, ($lines -join "`n"), [System.Windows.Forms.ToolTipIcon]::Info)',
    '        Start-Sleep -Milliseconds 1500',
    '        $icon.Dispose()',
    '      } catch {}',
    '    }',
    '  } catch {}',
    '}',
  ].join('\n');
}

class PersistentToastWorker {
  constructor() {
    this.proc = null;
  }

  ensureStarted() {
    if (process.platform !== 'win32') return null;
    if (process.env.MAJSOUL_DISABLE_NOTIFICATIONS === '1' || process.env.NODE_TEST_CONTEXT) return null;
    if (this.proc && this.proc.exitCode === null && this.proc.signalCode === null && this.proc.stdin?.writable) {
      return this.proc;
    }
    try {
      const encoded = Buffer.from(buildToastWorkerScript(), 'utf16le').toString('base64');
      const child = spawn(
        POWERSHELL_EXE,
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
        {windowsHide: true, stdio: ['pipe', 'ignore', 'ignore']},
      );
      child.stdin?.setDefaultEncoding?.('utf8');
      child.stdin?.on('error', () => {
        if (this.proc === child) this.proc = null;
      });
      child.on('error', () => {
        if (this.proc === child) this.proc = null;
      });
      child.on('exit', () => {
        if (this.proc === child) this.proc = null;
      });
      child.unref?.();
      this.proc = child;
      return child;
    } catch {
      this.proc = null;
      return null;
    }
  }

  send({title, body = '', bodyLines = null, gameHwnd = 0}) {
    const proc = this.ensureStarted();
    if (!proc?.stdin?.writable) return false;
    const safeTitle = String(title ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 120);
    const lines = normalizeBodyLines(body, bodyLines);
    const hwndNum = Number.isFinite(Number(gameHwnd)) ? Math.max(0, Math.trunc(Number(gameHwnd))) : 0;
    try {
      proc.stdin.write(`${JSON.stringify({title: safeTitle, bodyLines: lines, gameHwnd: hwndNum})}\n`, 'utf8');
      return true;
    } catch {
      this.proc = null;
      return false;
    }
  }

  close() {
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    try {
      if (proc.stdin && !proc.stdin.destroyed) proc.stdin.end();
    } catch {}
  }
}

const sharedToastWorker = new PersistentToastWorker();

export function warmupWindowsToast() {
  return Boolean(sharedToastWorker.ensureStarted());
}

export function closeWindowsToast() {
  sharedToastWorker.close();
}

export function sendWindowsToast({title, body = '', bodyLines = null, gameHwnd = 0}) {
  if (process.platform !== 'win32') return false;
  if (process.env.MAJSOUL_DISABLE_NOTIFICATIONS === '1' || process.env.NODE_TEST_CONTEXT) return false;
  if (sharedToastWorker.send({title, body, bodyLines, gameHwnd})) return true;
  try {
    const script = buildToastPowerShellScript({title, body, bodyLines, gameHwnd});
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn(
      POWERSHELL_EXE,
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      {windowsHide: true, stdio: 'ignore'},
    );
    child.on('error', () => {});
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

export function formatSigned(value) {
  if (!Number.isInteger(value)) return '';
  return `${value >= 0 ? '+' : ''}${value}`;
}

export function formatRoundLabel(roundOrContext, fallbackWind = 0) {
  if (!roundOrContext) return '本局';
  const wind = Number.isInteger(roundOrContext.wind) ? roundOrContext.wind : fallbackWind;
  const hand = roundOrContext.hand ?? roundOrContext.hand_number?.value ?? roundOrContext.hand_index;
  const honba = roundOrContext.honba ?? roundOrContext.counters?.honba ?? 0;
  const wName = WINDS[wind] ?? '东';
  const handNum = Number.isInteger(hand) ? (((hand - 1) % GAME.players) + 1) : '?';
  return `${wName}${handNum}局 ${honba}本场`;
}

export function parseWinScreenshotInfo(pathOrName) {
  if (typeof pathOrName !== 'string' || !pathOrName) return null;
  const name = pathOrName.split(/[\\/]/).at(-1);
  if (!name || /_终局_/.test(name)) return null;
  // Pattern 1: <stamp>_<han>番<fu>符<points>点[_<yakuSuffix>].png
  const regular = /_(\d+|未识别)番(\d+|未识别)符(\d+|未识别)点(?:_([^_]+))?\.png$/.exec(name);
  if (regular) {
    const han = /^\d+$/.test(regular[1]) ? Number(regular[1]) : null;
    const fu = /^\d+$/.test(regular[2]) ? Number(regular[2]) : null;
    const points = /^\d+$/.test(regular[3]) ? Number(regular[3]) : null;
    const yakuSuffix = regular[4] ? regular[4].trim() : '';
    return {han, fu, points, yakuman: null, yakumanLabel: null, yakuSuffix};
  }
  // Pattern 2: <stamp>_<points>点_<label>_<yakuSuffix>.png
  const yakumanWithYaku = /_(\d+|未识别)点_((?:(?:[两三四五六]|\d+)倍)?役满)_([^_]+)\.png$/.exec(name);
  if (yakumanWithYaku) {
    const points = /^\d+$/.test(yakumanWithYaku[1]) ? Number(yakumanWithYaku[1]) : null;
    return {han: null, fu: null, points, yakuman: 1, yakumanLabel: yakumanWithYaku[2], yakuSuffix: yakumanWithYaku[3].trim()};
  }
  // Pattern 3: <stamp>_<label><points>点.png
  const yakumanPlain = /_((?:(?:[两三四五六]|\d+)倍)?役满)(\d+|未识别)点\.png$/.exec(name);
  if (yakumanPlain) {
    const points = /^\d+$/.test(yakumanPlain[2]) ? Number(yakumanPlain[2]) : null;
    return {han: null, fu: null, points, yakuman: 1, yakumanLabel: yakumanPlain[1], yakuSuffix: ''};
  }
  return null;
}

export function mergeOwnWinInfo(existing, incoming) {
  if (!incoming) return existing ?? null;
  const base = existing ?? {};
  const yakuman = incoming.yakuman ?? base.yakuman ?? null;
  const yakumanLabel =
    incoming.yakumanLabel
    ?? base.yakumanLabel
    ?? (Number.isInteger(yakuman) && yakuman >= 1 ? (YAKUMAN_LABELS[yakuman - 1] ?? `${yakuman}倍役满`) : null);
  return {
    han: Number.isInteger(incoming.han) ? incoming.han : (base.han ?? null),
    fu: Number.isInteger(incoming.fu) ? incoming.fu : (base.fu ?? null),
    points: Number.isInteger(incoming.points) ? incoming.points : (base.points ?? null),
    yakuman,
    yakumanLabel,
    yakuSuffix: incoming.yakuSuffix || base.yakuSuffix || '',
  };
}

export function formatOwnWinInfo(winInfo) {
  if (!winInfo) return '';
  const suffix = typeof winInfo.yakuSuffix === 'string' ? winInfo.yakuSuffix.trim() : '';
  const yakumanLabel =
    winInfo.yakumanLabel
    ?? (Number.isInteger(winInfo.yakuman) && winInfo.yakuman >= 1
      ? (YAKUMAN_LABELS[winInfo.yakuman - 1] ?? `${winInfo.yakuman}倍役满`)
      : null);
  if (yakumanLabel) return `${yakumanLabel}${suffix}`;
  const hasHan = Number.isInteger(winInfo.han);
  const hasFu = Number.isInteger(winInfo.fu);
  if (hasHan && hasFu) return `${winInfo.han}番${winInfo.fu}符${suffix}`;
  if (hasHan) return `${winInfo.han}番${suffix}`;
  if (suffix) return suffix;
  return '';
}

export function formatSettlementSummary(result, context, positions = GAME.positions) {
  if (!result?.scores || !result?.seats) return '';
  const ordered = positions.filter(pos => Number.isInteger(result.seats[pos]));
  const parts = ordered.map(pos => {
    const seat = result.seats[pos];
    const score = result.scores[seat];
    const before = context?.scores?.[seat];
    const delta = Number.isInteger(before) && !context?.estimated && Number.isInteger(score) ? score - before : null;
    return `${score ?? '?'}${delta === null ? '' : `(${formatSigned(delta)})`}`;
  });
  return parts.join(' / ');
}

function isLikelyExhaustiveDraw(deltas, players, remaining = null) {
  if (!Array.isArray(deltas) || deltas.length < 2) return false;
  const pos = deltas.filter(d => d > 0);
  const neg = deltas.filter(d => d < 0);
  if (pos.length === 0 && neg.length === 0) return true;
  const maxPos = pos.length ? Math.max(...pos) : 0;
  const maxNegAbs = neg.length ? Math.max(...neg.map(d => -d)) : 0;
  // Standard exhaustive tenpai payment patterns (with or without riichi sticks).
  if (players === 4) {
    if (pos.length === 2 && neg.length === 2 && pos.every(d => d === 1500) && neg.every(d => d === -1500)) return true;
    if (pos.length === 3 && neg.length === 1 && pos.every(d => d === 1000) && neg[0] === -3000) return true;
    if (remaining === 0 && pos.length === 1 && pos[0] === 3000 && neg.length === 3 && neg.every(d => d === -1000)) return true;
    if (remaining === 0 && pos.length >= 1 && maxPos <= 3000 && maxNegAbs <= 4000 && pos.every(d => d <= 3000)) return true;
  } else if (players === 3) {
    if (pos.length === 2 && neg.length === 1 && pos.every(d => d === 1000) && neg[0] === -2000) return true;
    if (remaining === 0 && pos.length === 1 && pos[0] === 2000 && neg.length === 2 && neg.every(d => d === -1000)) return true;
    if (remaining === 0 && pos.length >= 1 && maxPos <= 2000 && maxNegAbs <= 3000 && pos.every(d => d <= 2000)) return true;
  }
  return false;
}

export function formatHandOutcomeLabel({
  result = null,
  context = null,
  ownWin = null,
  remaining = null,
  positions = GAME.positions,
} = {}) {
  const selfSeat = result?.seats?.self;
  const hasDeltas = Boolean(
    result?.scores
    && result?.seats
    && context?.scores
    && !context?.estimated
    && Number.isInteger(selfSeat),
  );
  const deltas = hasDeltas
    ? positions
      .map(pos => result.seats[pos])
      .filter(seat => Number.isInteger(seat))
      .map(seat => {
        const after = result.scores[seat];
        const before = context.scores[seat];
        return Number.isInteger(after) && Number.isInteger(before) ? after - before : null;
      })
    : [];
  const allDeltasValid = hasDeltas && deltas.length >= 2 && deltas.every(Number.isInteger);
  const selfDelta = allDeltasValid ? result.scores[selfSeat] - context.scores[selfSeat] : null;

  if (ownWin) {
    const pts = Number.isInteger(selfDelta) && selfDelta > 0
      ? selfDelta
      : (Number.isInteger(ownWin.points) ? ownWin.points : selfDelta);
    return Number.isInteger(pts) ? `和牌${formatSigned(pts)}` : '和牌';
  }
  if (!allDeltasValid) return '';

  const players = deltas.length;
  const exhaustive = isLikelyExhaustiveDraw(deltas, players, remaining);
  const pos = deltas.filter(d => d > 0);
  const neg = deltas.filter(d => d < 0);

  if (!exhaustive && selfDelta > 0) {
    return `和牌${formatSigned(selfDelta)}`;
  }
  if (!exhaustive && selfDelta < 0 && neg.length === 1 && pos.length >= 1) {
    return `放铳${formatSigned(selfDelta)}`;
  }
  return '';
}

export function extractMatchResultInfo(frameOrPageOrPath) {
  if (!frameOrPageOrPath) return null;
  if (typeof frameOrPageOrPath === 'string') {
    const name = frameOrPageOrPath.split(/[\\/]/).at(-1) ?? '';
    const m = /_终局_第([^_]+)名_([^_]+)点_PT([^_]+)\.png$/.exec(name);
    if (!m) return null;
    const rank = /^\d+$/.test(m[1]) ? Number(m[1]) : null;
    const points = /^-?\d+$/.test(m[2]) ? Number(m[2]) : null;
    const ptChange = /^[+-]?\d+$/.test(m[3]) ? Number(m[3]) : null;
    if (rank === null && points === null && ptChange === null) return null;
    return {rank, points, ptChange};
  }
  const page = frameOrPageOrPath.result_page ?? frameOrPageOrPath;
  if (page?.kind === 'match-result') {
    const rank = Number.isInteger(page.rank) ? page.rank : null;
    const points = Number.isInteger(page.points) ? page.points : null;
    const ptChange = Number.isInteger(page.ptChange) ? page.ptChange : null;
    if (page.complete || (rank !== null && (points !== null || ptChange !== null))) {
      return {rank, points, ptChange};
    }
    if (typeof page.screenshot === 'string') {
      return extractMatchResultInfo(page.screenshot);
    }
  }
  if (typeof page?.screenshot === 'string') {
    const fromShot = extractMatchResultInfo(page.screenshot);
    if (fromShot) return fromShot;
  }
  return null;
}

export function formatMatchResultBody(info) {
  if (!info) return '';
  const parts = [];
  if (Number.isInteger(info.rank)) parts.push(`第${info.rank}名`);
  if (Number.isInteger(info.points)) parts.push(`${info.points}点`);
  if (Number.isInteger(info.ptChange)) parts.push(`PT${formatSigned(info.ptChange)}`);
  return parts.join(' / ');
}

function frameForegroundFlag(frame) {
  if (!frame || typeof frame !== 'object') return null;
  if (typeof frame.windowForeground === 'boolean') return frame.windowForeground;
  const flag = frame.state?.captureEvidence?.windowForeground;
  return typeof flag === 'boolean' ? flag : null;
}

export class WindowsNotifier {
  constructor({
    enabled = true,
    cooldownMs = 30000,
    now = () => Date.now(),
    sender = sendWindowsToast,
    warmer = warmupWindowsToast,
    closer = closeWindowsToast,
    isBackground = null,
    appTitle = GAME.sanma ? '听风执牌（三麻）' : '听风执牌（四麻）',
  } = {}) {
    this.enabled = enabled && process.env.MAJSOUL_DISABLE_NOTIFICATIONS !== '1';
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.sender = sender;
    this.warmer = warmer;
    this.closer = closer;
    this.isBackground = isBackground;
    this.appTitle = appTitle;
    this.sentHands = new Set();
    this.sentMatches = new Set();
    this.cooldowns = new Map();
    this.hwnd = 0;
    this.matchSeq = 1;
  }

  warmup() {
    if (!this.enabled) return false;
    try {
      return this.warmer?.() === true;
    } catch {
      return false;
    }
  }

  close() {
    try {
      this.closer?.();
    } catch {}
  }

  setWindow(windowOrHwnd) {
    const raw = typeof windowOrHwnd === 'object' ? windowOrHwnd?.id : windowOrHwnd;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) this.hwnd = Math.trunc(parsed);
  }

  shouldNotify({frame = null, hwnd = null} = {}) {
    if (!this.enabled) return false;
    const targetHwnd = Number.isFinite(Number(hwnd)) && Number(hwnd) > 0 ? Math.trunc(Number(hwnd)) : this.hwnd;
    if (typeof this.isBackground === 'function') {
      return this.isBackground({frame, hwnd: targetHwnd}) === true;
    }
    const fg = frameForegroundFlag(frame);
    if (fg === true) return false;
    return true;
  }

  emit({title = null, titleSuffix = '', body = '', bodyLines = null, dedupeKey = null, onceSet = null, frame = null, hwnd = null}) {
    if (!this.shouldNotify({frame, hwnd})) return false;
    if (onceSet && dedupeKey) {
      if (onceSet.has(dedupeKey)) return false;
      onceSet.add(dedupeKey);
    } else if (dedupeKey) {
      const ts = this.now();
      const prev = this.cooldowns.get(dedupeKey);
      if (Number.isFinite(prev) && ts - prev < this.cooldownMs) return false;
      this.cooldowns.set(dedupeKey, ts);
    }
    const targetHwnd = Number.isFinite(Number(hwnd)) && Number(hwnd) > 0 ? Math.trunc(Number(hwnd)) : this.hwnd;
    const resolvedTitle = title ?? (titleSuffix ? `${this.appTitle} · ${titleSuffix}` : this.appTitle);
    const normalizedLines = normalizeBodyLines(body, bodyLines);
    const resolvedBody = normalizedLines.join('\n');
    return this.sender({title: resolvedTitle, body: resolvedBody, bodyLines: normalizedLines, gameHwnd: targetHwnd});
  }

  notifyHandEnded({
    roundKey,
    roundLabel = '本局',
    result = null,
    context = null,
    ownWin = null,
    remaining = null,
    summary = '',
    frame = null,
    hwnd = null,
  }) {
    const key = roundKey ? String(roundKey) : `${roundLabel}:${summary}`;
    let title;
    let bodyLines;
    if (result?.scores && result?.seats) {
      const outcome = formatHandOutcomeLabel({result, context, ownWin, remaining});
      title = outcome ? `${roundLabel} · ${outcome}` : roundLabel;
      const winText = formatOwnWinInfo(ownWin);
      const scoresText = formatSettlementSummary(result, context);
      bodyLines = [winText, scoresText].filter(Boolean);
    } else {
      const outcome = ownWin ? formatHandOutcomeLabel({ownWin}) : '';
      title = outcome ? `${roundLabel} · ${outcome}` : roundLabel;
      const winText = formatOwnWinInfo(ownWin);
      bodyLines = [winText, summary].filter(Boolean);
      if (!bodyLines.length) bodyLines = ['本局已结束'];
    }
    return this.emit({
      title,
      bodyLines,
      dedupeKey: key,
      onceSet: this.sentHands,
      frame,
      hwnd,
    });
  }

  notifyMatchEnded({matchKey = null, matchResult = null, summary = '', frame = null, hwnd = null}) {
    const parsed = matchResult ?? extractMatchResultInfo(frame);
    const body = formatMatchResultBody(parsed) || summary || '整场对局已结束';
    const key = matchKey ? String(matchKey) : `match:${this.matchSeq}`;
    return this.emit({
      titleSuffix: '整场结束',
      body,
      dedupeKey: key,
      onceSet: this.sentMatches,
      frame,
      hwnd,
    });
  }

  notifyRetryFailure({action = '', retryCount = null, reason = '', key = null, frame = null, hwnd = null}) {
    const label = action ? actionName(action) : '操作';
    const countText = Number.isInteger(retryCount) ? `（第${retryCount}次重试）` : '';
    const detail = reason ? `：${reason}` : '，请检查窗口状态';
    return this.emit({
      titleSuffix: '动作重试失败',
      body: `${label}${countText}仍未生效${detail}`,
      dedupeKey: key ?? `retry:${action}:${reason}`,
      frame,
      hwnd,
    });
  }

  notifyBlocked({reason = '持续未推进', key = null, frame = null, hwnd = null}) {
    return this.emit({
      titleSuffix: '运行阻塞',
      body: reason,
      dedupeKey: key ?? `blocked:${reason}`,
      frame,
      hwnd,
    });
  }

  observeLiveEvent(event, {frame = null, hwnd = null} = {}) {
    if (!event?.kind) return false;
    if (event.kind === 'verified_unchanged_discard_retry' && (event.retryCount ?? 0) >= 2) {
      return this.notifyRetryFailure({
        action: event.action,
        retryCount: event.retryCount,
        reason: '新画面仍显示原手牌',
        key: `retry:discard:${event.decisionId ?? event.action}`,
        frame,
        hwnd,
      });
    }
    if (event.kind === 'verified_unchanged_pass_retry' && (event.retryCount ?? 0) >= 2) {
      return this.notifyRetryFailure({
        action: 'PASS',
        retryCount: event.retryCount,
        reason: '跳过按钮仍未消失',
        key: 'retry:pass',
        frame,
        hwnd,
      });
    }
    if (event.kind === 'verified_unchanged_riichi_retry' && (event.retryCount ?? 0) >= 2) {
      return this.notifyRetryFailure({
        action: event.action,
        retryCount: event.retryCount,
        reason: '立直/鸣牌动作多次重试未生效',
        key: `retry:special:${event.action}`,
        frame,
        hwnd,
      });
    }
    if (event.kind === 'input_outcome_unconfirmed') {
      return this.notifyRetryFailure({
        action: event.action,
        reason: event.reason ?? '动作执行结果未确认',
        key: `retry:unconfirmed:${event.decisionId ?? event.action}`,
        frame,
        hwnd,
      });
    }
    if (event.kind === 'unresolved') {
      return this.notifyBlocked({
        reason: `动作尚未确认：${event.reason ?? event.status ?? '需要核对局面'}`,
        key: `blocked:unresolved:${event.reason ?? event.status ?? ''}`,
        frame,
        hwnd,
      });
    }
    if (event.kind === 'evidence_blocked') {
      return this.notifyBlocked({
        reason: `持续未推进：${event.reason ?? '局面识别阻塞'}`,
        key: `blocked:evidence:${event.reason ?? ''}`,
        frame,
        hwnd,
      });
    }
    if (event.kind === 'auto_win_idle_until_next_round') {
      return this.notifyBlocked({
        reason: '疑似已和牌但未进入结算，本局已进入静默等待',
        key: 'blocked:auto_win_idle',
        frame,
        hwnd,
      });
    }
    if (event.kind === 'next_opening_blocked') {
      return this.notifyBlocked({
        reason: `未能接续新一局：${event.reason ?? '开局状态异常'}`,
        key: `blocked:next_opening:${event.reason ?? ''}`,
        frame,
        hwnd,
      });
    }
    if (event.kind === 'recoverable_runtime_wait' && /^Frozen game image/i.test(event.reason ?? '')) {
      return this.notifyBlocked({
        reason: '游戏画面连续60秒无变化，已暂停识别和点击',
        key: 'blocked:frozen_image',
        frame,
        hwnd,
      });
    }
    return false;
  }

  resetMatch() {
    this.matchSeq++;
    this.sentHands.clear();
    this.cooldowns.clear();
  }
}
