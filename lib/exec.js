// Komut çalıştırma: canlı çıktı, zaman aşımı, süreç grubunu sonlandırma ve isteğe bağlı bubblewrap sandbox.
// Ayrıca kalıcı shell oturumu (cwd/env/süreklilik) ve arka plan süreçleri desteklenir.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_LOG_BYTES = 512 * 1024;

let bwrapPath;
function findBwrap() {
  if (bwrapPath !== undefined) return bwrapPath;
  bwrapPath = null;
  for (const dir of (process.env.PATH || '/usr/bin:/bin').split(path.delimiter)) {
    const p = path.join(dir, 'bwrap');
    try { fs.accessSync(p, fs.constants.X_OK); bwrapPath = p; break; } catch { /* sıradaki */ }
  }
  return bwrapPath;
}
const sandboxAvailable = () => !!findBwrap();

const SECRET_ENV_RE = /(^(ELECTRON_|OPENROUTER_|GEMINI_|GOOGLE_API|ANTHROPIC_|OPENAI_|AWS_|AZURE_|GCP_|GITHUB_|GH_|GITLAB_|NPM_|DOCKER_|KUBE|SSH_AUTH_SOCK|GPG_AGENT_INFO)|_(API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|CREDENTIAL)S?$)/i;

function sanitizedEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (v !== undefined && !SECRET_ENV_RE.test(k)) out[k] = v;
  }
  return out;
}

// Sandbox: sistem salt okunur, ev dizini ve /run boş (tmpfs), ortam değişkenleri temizlenmiş, yalnızca çalışma klasörü yazılabilir.
function bwrapArgs(workspace, { network }) {
  const home = os.homedir();
  const args = [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    '--tmpfs', '/run',
    '--tmpfs', home,
    '--bind', workspace, workspace,
    '--chdir', workspace,
    '--unshare-pid', '--unshare-ipc', '--unshare-uts',
    '--die-with-parent', '--new-session',
    '--clearenv',
    '--setenv', 'PATH', process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    '--setenv', 'HOME', home,
    '--setenv', 'TERM', process.env.TERM || 'xterm-256color',
    '--setenv', 'LANG', process.env.LANG || 'C.UTF-8'
  ];
  if (!network) args.push('--unshare-net');
  return args;
}

function shellSpec(sandbox, cwd) {
  const isWin = process.platform === 'win32';
  if (sandbox) {
    const bw = findBwrap();
    if (!bw) return { error: 'Hata: sandbox açık ama bubblewrap (bwrap) kurulu değil. Komut çalıştırılmadı.' };
    return { file: bw, argsPrefix: [...bwrapArgs(cwd, sandbox)] };
  }
  return isWin
    ? { file: 'powershell.exe', argsPrefix: ['-NoProfile', '-NonInteractive'] }
    : { file: '/bin/bash', argsPrefix: [] };
}

function spawnShell(command, { cwd, sandbox = null, detached = true, stdio }) {
  const isWin = process.platform === 'win32';
  const spec = shellSpec(sandbox, cwd);
  if (spec.error) return { error: spec.error };
  const args = isWin && !sandbox
    ? [...spec.argsPrefix, '-Command', command]
    : sandbox
      ? [...spec.argsPrefix, '/bin/bash', '-c', command]
      : ['-c', command];
  const child = spawn(spec.file, args, {
    cwd, env: sanitizedEnv(), detached: !isWin && detached, windowsHide: true, stdio
  });
  return { child };
}

function killTree(child, isWin = process.platform === 'win32') {
  if (!child?.pid) return;
  if (isWin) {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* yok */ }
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* yok */ }
  }
  try { child.kill('SIGKILL'); } catch { /* zaten bitti */ }
}

function runCommand(command, { cwd, timeoutMs = 60000, signal, onData, sandbox = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      // stdin kapalı: etkileşimli komutlar sonsuza kadar beklemez.
      const started = spawnShell(command, { cwd, sandbox, stdio: ['ignore', 'pipe', 'pipe'] });
      if (started.error) { resolve(started.error); return; }
      child = started.child;
    } catch (e) {
      resolve(`Hata: komut başlatılamadı: ${e.message}`);
      return;
    }

    let stdout = '', stderr = '', total = 0, why = null, finished = false;
    const kill = (reason) => {
      why ??= reason;
      killTree(child);
    };
    const timer = setTimeout(() => kill(`zaman aşımı (${Math.round(timeoutMs / 1000)} sn)`), timeoutMs);
    const onAbort = () => kill('durduruldu');
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });

    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    const collect = (isErr) => {
      const dec = isErr ? errDecoder : outDecoder;
      return (chunk) => {
        total += chunk.length;
        if (total > MAX_OUTPUT) { kill('çıktı çok büyük'); return; }
        const s = dec.write(chunk);
        if (!s) return;
        if (isErr) stderr += s; else stdout += s;
        onData?.(s);
      };
    };
    child.stdout.on('data', collect(false));
    child.stderr.on('data', collect(true));

    const done = (code, sig, spawnErr) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const tailOut = outDecoder.end();
      const tailErr = errDecoder.end();
      if (tailOut) { stdout += tailOut; onData?.(tailOut); }
      if (tailErr) { stderr += tailErr; onData?.(tailErr); }
      let out = stdout;
      if (stderr) out += (out ? '\n' : '') + '[stderr]\n' + stderr;
      if (spawnErr) out += `\n[hata: ${spawnErr.message}]`;
      else if (code !== 0 || why) out += `\n[çıkış kodu: ${code ?? sig ?? 'bilinmiyor'}${why ? `, sonlandırıldı: ${why}` : ''}]`;
      resolve(out.trim() || '(çıktı yok)');
    };
    child.on('error', (e) => done(null, null, e));
    child.on('close', (code, sig) => done(code, sig));
  });
}

// ------------------------------------------------------------ kalıcı shell
// Küçük modellerin "cd x && ..." tekrarını önlemek ve watch/dev sunucusu gibi
// uzun ömürlü işleri yönetebilmek için süreç başına oturum tutulur.
// Oturum çalışma klasörüne ve sandbox ayarına bağlıdır; biri değişirse yeniden açılır.
const sessions = new Map();

function sessionKeyOf(cwd, sandbox) {
  const net = sandbox ? (sandbox.network ? 'net' : 'nonet') : 'nosandbox';
  return `${path.resolve(cwd)}|${net}`;
}

function createShellSession({ cwd, sandbox = null, maxBuffered = MAX_OUTPUT }) {
  const spec = shellSpec(sandbox, cwd);
  if (spec.error) throw new Error(spec.error);
  const isWin = process.platform === 'win32';
  // `-s`: stdin'den komut okur ama etkileşimli değildir (echo/prompt/job-control gürültüsü yok),
  // süreç yine canlı kalır; cwd/env değişkenleri komutlar arasında korunur.
  const args = isWin && !sandbox
    ? [...spec.argsPrefix, '-Command', '-']
    : [...(sandbox ? spec.argsPrefix.concat('/bin/bash') : []), '--noprofile', '--norc', '-s'];
  const child = spawn(spec.file, args, {
    cwd,
    env: { ...sanitizedEnv(), PS1: '', PROMPT_COMMAND: '' },
    // Kendi süreç grubunda değil: oturum ömrü boyunca yaşar, exec sonunda öldürülmez.
    detached: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const decoder = new StringDecoder('utf8');
  let buffered = '';
  let closed = false;
  let exitInfo = null;
  const waiters = new Set();
  const notify = () => {
    for (const w of [...waiters]) w();
  };
  const onData = (chunk) => {
    buffered += decoder.write(chunk);
    if (buffered.length > maxBuffered) buffered = buffered.slice(-maxBuffered);
    notify();
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('close', (code, sig) => { closed = true; exitInfo = { code, sig }; notify(); });
  child.on('error', (e) => { closed = true; exitInfo = { error: e }; notify(); });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Marker tabanlı eşitleme: komut bitince benzersiz bir işaret yazılır, işaret
  // görülene kadar beklenir. Böylece çıktı komut sınırlarında bölünür.
  async function execOnce(command, { timeoutMs = 60000, signal } = {}) {
    if (closed) return { ok: false, output: `[hata: shell oturumu kapandı${exitInfo?.code != null ? ` (çıkış kodu: ${exitInfo.code})` : ''}]` };
    const mark = `__EMO_DONE_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}__`;
    buffered = '';
    // Komut ve işaret aynı oturumda çalışır; shell'e göre çıkış kodu işaretle yazılır.
    const markerCommand = isWin
      ? `$global:LASTEXITCODE = 0\n${command}\n$__emoStatus = if (-not $?) { 1 } elseif ($LASTEXITCODE -ne 0) { $LASTEXITCODE } else { 0 }\n[Console]::Out.WriteLine('${mark}:' + $__emoStatus)\n`
      : `${command}\nprintf '\\n%s:%s\\n' '${mark}' "$?"\n`;
    child.stdin.write(markerCommand);
    const deadline = Date.now() + timeoutMs;
    const onAbort = () => { close(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      while (true) {
        const idx = buffered.indexOf(`${mark}:`);
        if (idx >= 0 && buffered.indexOf('\n', idx) > 0) {
          const text = buffered.slice(0, idx).replace(/^\r?\n/, '');
          const codeText = buffered.slice(idx + mark.length + 1).split('\n')[0].trim();
          return { ok: true, output: text.replace(/\r/g, '').trimEnd(), code: Number(codeText) };
        }
        if (closed) {
          return { ok: false, output: buffered.replace(/\r/g, '').trimEnd() || '[hata: shell oturumu kapandı]', code: exitInfo?.code };
        }
        if (signal?.aborted) {
          // TTY olmadan Ctrl-C stdin'e yazılamaz: asılı komut oturumu kilitlemesin diye kapatılır.
          close();
          return { ok: false, aborted: true, output: buffered.replace(/\r/g, '').trimEnd() };
        }
        if (Date.now() > deadline) {
          close();
          return { ok: false, timeout: true, output: buffered.replace(/\r/g, '').trimEnd() };
        }
        await Promise.race([
          new Promise((r) => { waiters.add(r); setTimeout(() => { waiters.delete(r); r(); }, 100); }),
          sleep(100)
        ]);
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  function close() {
    closed = true;
    killTree(child, process.platform === 'win32');
  }

  return { child, execOnce, close, key: sessionKeyOf(cwd, sandbox) };
}

function getShellSession({ cwd, sandbox = null }) {
  const key = sessionKeyOf(cwd, sandbox);
  const cur = sessions.get(key);
  if (cur && !cur.closed) return cur;
  const s = createShellSession({ cwd, sandbox });
  sessions.set(key, s);
  return s;
}

function closeAllShellSessions() {
  for (const s of sessions.values()) {
    try { s.close(); } catch { /* yok */ }
  }
  sessions.clear();
}

// ---------------------------------------------------------- arka plan işleri
// Uzun ömürlü süreçler (npm run dev, watch) doğrudan başlatılır; çıktıları
// sınırlı bir halka tamponda tutulur ve background_output ile okunur.
const backgroundJobs = new Map();
let bgSeq = 0;

function startBackground(command, { cwd, sandbox = null } = {}) {
  bgSeq++;
  const id = `bg${bgSeq}`;
  const started = spawnShell(command, { cwd, sandbox, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (started.error) return { ok: false, output: started.error };
  const child = started.child;
  const job = { id, command, cwd, pid: child.pid, output: '', exited: false, code: null, startedAt: Date.now() };
  const collect = (buf) => {
    job.output += buf.toString('utf8');
    if (job.output.length > MAX_LOG_BYTES) job.output = job.output.slice(-MAX_LOG_BYTES);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.on('close', (code, sig) => { job.exited = true; job.code = code ?? sig ?? null; });
  child.on('error', (e) => { job.exited = true; job.code = null; job.output += `\n[hata: ${e.message}]`; });
  backgroundJobs.set(id, job);
  return { ok: true, id, pid: child.pid };
}

function readBackground(id, { tail = 8000 } = {}) {
  const job = backgroundJobs.get(id);
  if (!job) return null;
  return {
    id: job.id, command: job.command, pid: job.pid, exited: job.exited, code: job.code,
    runningForMs: Date.now() - job.startedAt,
    output: job.output.length > tail ? `… (önceki çıktı kesildi)\n${job.output.slice(-tail)}` : job.output
  };
}

function listBackground() {
  return [...backgroundJobs.values()].map((j) => ({
    id: j.id, command: j.command, pid: j.pid, exited: j.exited, code: j.code, runningForMs: Date.now() - j.startedAt
  }));
}

function stopBackground(id) {
  const job = backgroundJobs.get(id);
  if (!job) return false;
  try { process.kill(-job.pid, 'SIGTERM'); } catch { /* yok */ }
  try { process.kill(job.pid, 'SIGTERM'); } catch { /* yok */ }
  job.exited = true;
  setTimeout(() => { try { process.kill(-job.pid, 'SIGKILL'); } catch { /* yok */ } }, 2000).unref?.();
  return true;
}

function closeAllBackgroundJobs() {
  for (const id of backgroundJobs.keys()) stopBackground(id);
  backgroundJobs.clear();
}

module.exports = {
  runCommand, sandboxAvailable, bwrapArgs, sanitizedEnv,
  getShellSession, closeAllShellSessions,
  startBackground, readBackground, listBackground, stopBackground, closeAllBackgroundJobs
};
