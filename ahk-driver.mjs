import {spawn} from 'node:child_process';
import {mkdir, appendFile, readFile, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {actionTimeoutMs} from './ahk-output.mjs';

// One resident AHK output worker connected via direct UTF-8 stdin/stdout pipes.
// Zero disk-queue polling, zero fs.watch contention, in-memory single-flight
// serialization, tiered action timeouts, and strict inputNotSent vs unknown
// outcome separation.
export class AhkDriver {
  constructor(root, options = {}) {
    this.root = root;
    this.options = options;
    this.pending = new Map();
    this.receipts = new Map();
    this.tail = '';
    this.inFlight = null;
    this.flightLock = Promise.resolve();
    this.closed = false;
  }

  async start() {
    if (this.ready) return this.ready;
    this.ready = this.initialize();
    return this.ready;
  }

  async initialize() {
    const dir = join(this.root, 'queue');
    await mkdir(dir, {recursive: true});
    const virtual = this.options.virtualPointer ?? (process.env.MAJSOUL_VIRTUAL_POINTER === '1');
    const token = this.options.readyToken ?? randomUUID();
    const readyTimeout = this.options.readyTimeoutMs ?? (virtual ? 15000 : 5000);
    const ready = this.wait(token, readyTimeout);
    const executable = this.options.executable ?? join(this.root, 'runtime/ahk-v2/AutoHotkey64.exe');
    const scriptPath = this.options.scriptPath ?? join(this.root, 'output.ahk');
    const args = this.options.args ?? [
      '/ErrorStdOut',
      scriptPath,
      '--worker',
      token,
      ...(virtual ? ['--virtual-pointer'] : []),
      ...(this.options.extraArgs ?? []),
    ];
    this.child = spawn(executable, args, {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.diagnostics = '';
    this.child.stdout.on('data', chunk => this.handleStdout(chunk));
    this.child.stderr.on('data', chunk => {
      this.diagnostics = (this.diagnostics + chunk).slice(-16384);
    });
    this.child.stdin.on('error', () => {});
    this.child.on('error', e => this.fail(e));
    this.child.on('close', code => {
      const conflict = this.diagnostics.split(/\r?\n/).some(line => line.trim() === 'virtual_pointer_failed:different_virtual_pointer_helper_already_loaded');
      const error = conflict
        ? Object.assign(Error('雀魂仍加载着另一目录的后台点击组件。请退出并重新打开雀魂，再启动听风执牌。'), {code: 'INPUT_HELPER_CONFLICT'})
        : Error(`AHK worker exited ${code}: ${this.diagnostics}`);
      this.fail(error);
    });
    try {
      await ready;
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    }
  }

  handleStdout(chunk) {
    this.tail += chunk;
    let newline;
    while ((newline = this.tail.indexOf('\n')) >= 0) {
      const line = this.tail.slice(0, newline).replace(/\r$/, '').trim();
      this.tail = this.tail.slice(newline + 1);
      if (!line) continue;
      const [id, status] = line.split('\t');
      const entry = this.pending.get(id);
      if (entry) {
        clearTimeout(entry.timer);
        this.pending.delete(id);
        if (status === 'input_sent' || status === 'ready') entry.resolve(line);
        else entry.reject(Error(`AHK rejected input: ${line}`));
      } else {
        this.receipts.set(id, line);
        while (this.receipts.size > 256) this.receipts.delete(this.receipts.keys().next().value);
      }
    }
  }

  // In-memory single-flight send over stdin/stdout pipe.
  async send(id, line, timeoutMs = 2500) {
    if (!id || typeof line !== 'string' || !line.trim()) {
      throw Object.assign(Error('Invalid AHK pipe command'), {inputNotSent: true});
    }
    const previous = this.flightLock;
    let release;
    this.flightLock = new Promise(r => { release = r; });
    await previous.catch(() => {});
    try {
      if (this.closed) throw Object.assign(Error('AHK driver closed'), {inputNotSent: true});
      await this.start();
      if (this.error) throw Object.assign(this.error, {inputNotSent: true});
      if (!this.child?.stdin || !this.child.stdin.writable || this.child.exitCode !== null || this.child.signalCode !== null) {
        throw Object.assign(Error('AHK worker pipe is not writable'), {inputNotSent: true});
      }
      const receiptPromise = this.wait(id, timeoutMs);
      this.inFlight = {id, line, startedAt: Date.now()};
      try {
        await new Promise((resolve, reject) => {
          this.child.stdin.write(line + '\n', 'utf8', err => (err ? reject(err) : resolve()));
        });
      } catch (writeErr) {
        const pending = this.pending.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(id);
        }
        this.inFlight = null;
        receiptPromise.catch(() => {});
        throw Object.assign(Error(`AHK pipe write failed: ${writeErr.message}`), {inputNotSent: true});
      }
      return await receiptPromise;
    } finally {
      if (this.inFlight?.id === id) this.inFlight = null;
      release();
    }
  }

  async selfTestFocus(window) {
    if (!Number.isSafeInteger(window?.id) || window.id <= 0)
      throw Error('Startup silent output check requires a game window handle');
    if (this.inFlight) throw Error('Startup silent output check cannot replace a pending action');
    await this.start();
    const id = randomUUID();
    const line = [id, Math.floor(Date.now() / 1000) + 5, window.id, 0, 'startup_focus', 0, 0].join('\t');
    try {
      const ack = await this.send(id, line, actionTimeoutMs('startup_focus'));
      const [receiptId, status, detail = ''] = ack.split('\t');
      const silentProof = /^startup_focus_verified;mode=silent_activate;hwnd=(\d+);before=(\d+);after=(\d+);cursor_preserved=1;thread_clean=1;window_state_restored=1$/.exec(detail);
      const validSilent = silentProof && silentProof[1] === String(window.id) && (silentProof[2] === silentProof[1] || silentProof[3] !== silentProof[1]);
      if (receiptId !== id || status !== 'input_sent' || !validSilent)
        throw Error(`Startup silent output check unconfirmed: ${ack}`);
      return {id, windowId: window.id, ack};
    } catch (error) {
      await this.retireQueue('startup-self-test-failed').catch(() => {});
      throw error;
    }
  }

  wait(id, timeoutMs = 2500) {
    if (this.error) return Promise.reject(this.error);
    const cached = this.receipts.get(id);
    if (cached) {
      this.receipts.delete(id);
      return ['input_sent', 'ready'].includes(cached.split('\t')[1])
        ? Promise.resolve(cached)
        : Promise.reject(Error(`AHK rejected input: ${cached}`));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error('AHK receipt timeout; outcome unknown, do not retry'));
      }, timeoutMs);
      this.pending.set(id, {resolve, reject, timer});
    });
  }

  fail(error) {
    this.error = error;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.inFlight = null;
  }

  abortPending(reason = 'Aborted by user interrupt') {
    const err = Object.assign(Error(reason), {name: 'AbortError', inputNotSent: !this.inFlight});
    const hadInFlight = Boolean(this.inFlight);
    this.closed = true;
    this.fail(err);
    if (hadInFlight && this.child && this.child.exitCode === null && this.child.signalCode === null) {
      try { this.child.kill(); } catch {}
    } else if (this.child?.stdin?.writable) {
      try { this.child.stdin.end('__quit__\n'); } catch {}
    }
  }

  async close() {
    this.closed = true;
    this.fail(Error('AHK driver closed'));
    const child = this.child;
    if (child?.once && child.exitCode === null && child.signalCode === null) {
      try {
        if (child.stdin?.writable) child.stdin.end('__quit__\n');
      } catch {}
      await new Promise((resolve, reject) => {
        const killTimer = setTimeout(() => {
          try { child.kill(); } catch {}
        }, 250);
        const failTimer = setTimeout(() => {
          clearTimeout(killTimer);
          reject(Error('AHK worker did not exit; queue retained'));
        }, 2000);
        child.once('exit', () => {
          clearTimeout(killTimer);
          clearTimeout(failTimer);
          resolve();
        });
      });
    } else {
      try { child?.kill(); } catch {}
    }
  }

  async retireQueue(reason) {
    const active = this.inFlight ? {...this.inFlight} : null;
    await this.close();
    const directory = join(this.root, 'queue');
    await mkdir(directory, {recursive: true}).catch(() => {});
    if (active) {
      await appendFile(
        join(directory, 'retired-actions.jsonl'),
        JSON.stringify({at: new Date().toISOString(), reason, name: 'pipe-in-flight', id: active.id, content: active.line}) + '\n',
        'utf8',
      ).catch(() => {});
    }
    // Also clean up any legacy disk queue files left by older sessions.
    for (const name of ['request.tsv', 'processing.tsv']) {
      const path = join(directory, name);
      let content;
      try { content = await readFile(path, 'utf8'); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      await appendFile(join(directory, 'retired-actions.jsonl'), JSON.stringify({at: new Date().toISOString(), reason, name, content}) + '\n', 'utf8');
      await unlink(path).catch(e => { if (e.code !== 'ENOENT') throw e; });
    }
  }
}
