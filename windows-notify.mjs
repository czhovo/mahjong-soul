import {spawn} from 'node:child_process';
import {GAME} from './game-rules.mjs';
import {actionName} from './terminal-log.mjs';

const POWERSHELL_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const TOAST_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
const WINDS = ['东', '南', '西', '北'];
const POSITIONS = GAME.sanma
  ? {self: '自己', right: '下家', left: '上家'}
  : {self: '自己', right: '下家', opposite: '对家', left: '上家'};

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

export function buildToastPowerShellScript({title, body, gameHwnd = 0, dryRun = false}) {
  const safeTitle = String(title ?? '').replace(/[\r\n]+/g, ' ').slice(0, 120);
  const safeBody = String(body ?? '').replace(/[\r\n]+/g, ' ').slice(0, 300);
  const xml = `<toast><visual><binding template="ToastText02"><text id="1">${xmlEscape(safeTitle)}</text><text id="2">${xmlEscape(safeBody)}</text></binding></visual></toast>`;
  const hwndNum = Number.isFinite(Number(gameHwnd)) ? Math.max(0, Math.trunc(Number(gameHwnd))) : 0;
  const lines = [
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
  return lines.join('\n');
}

export function sendWindowsToast({title, body, gameHwnd = 0}) {
  if (process.platform !== 'win32') return false;
  if (process.env.MAJSOUL_DISABLE_NOTIFICATIONS === '1' || process.env.NODE_TEST_CONTEXT) return false;
  try {
    const script = buildToastPowerShellScript({title, body, gameHwnd});
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

export function formatRoundLabel(roundOrContext, fallbackWind = 0) {
  if (!roundOrContext) return '本局';
  const wind = Number.isInteger(roundOrContext.wind) ? roundOrContext.wind : fallbackWind;
  const hand = roundOrContext.hand ?? roundOrContext.hand_number?.value ?? roundOrContext.hand_index;
  const honba = roundOrContext.honba ?? roundOrContext.counters?.honba ?? 0;
  const wName = WINDS[wind] ?? '东';
  const handNum = Number.isInteger(hand) ? (((hand - 1) % GAME.players) + 1) : '?';
  return `${wName}${handNum}局 ${honba}本场`;
}

export function formatSettlementSummary(result, context) {
  if (!result?.scores || !result?.seats) return '';
  const parts = Object.entries(POSITIONS).map(([pos, name]) => {
    const seat = result.seats[pos];
    const score = result.scores[seat];
    const before = context?.scores?.[seat];
    const delta = Number.isInteger(before) && !context?.estimated && Number.isInteger(score) ? score - before : null;
    return `${name} ${score ?? '?'}${delta === null ? '' : `(${delta >= 0 ? '+' : ''}${delta})`}`;
  });
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
    isBackground = null,
    appTitle = GAME.sanma ? '听风执牌（三麻）' : '听风执牌（四麻）',
  } = {}) {
    this.enabled = enabled && process.env.MAJSOUL_DISABLE_NOTIFICATIONS !== '1';
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.sender = sender;
    this.isBackground = isBackground;
    this.appTitle = appTitle;
    this.sentHands = new Set();
    this.sentMatches = new Set();
    this.cooldowns = new Map();
    this.hwnd = 0;
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

  emit({titleSuffix, body, dedupeKey = null, onceSet = null, frame = null, hwnd = null}) {
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
    const title = titleSuffix ? `${this.appTitle} · ${titleSuffix}` : this.appTitle;
    return this.sender({title, body, gameHwnd: targetHwnd});
  }

  notifyHandEnded({roundKey, roundLabel = '本局', summary = '', frame = null, hwnd = null}) {
    const key = roundKey ? String(roundKey) : `${roundLabel}:${summary}`;
    const body = summary ? `${roundLabel}｜${summary}` : `${roundLabel} 已结束`;
    return this.emit({
      titleSuffix: '本局结束',
      body,
      dedupeKey: key,
      onceSet: this.sentHands,
      frame,
      hwnd,
    });
  }

  notifyMatchEnded({matchKey = null, summary = '整场对局已结束', frame = null, hwnd = null}) {
    const key = matchKey ? String(matchKey) : `match:${summary}`;
    return this.emit({
      titleSuffix: '整场结束',
      body: summary,
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
    this.sentHands.clear();
    this.cooldowns.clear();
  }
}
