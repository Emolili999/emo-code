// Komut çalıştırma: canlı çıktı, zaman aşımı, süreç grubunu sonlandırma ve isteğe bağlı bubblewrap sandbox.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

const MAX_OUTPUT = 2 * 1024 * 1024;

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

function runCommand(command, { cwd, timeoutMs = 60000, signal, onData, sandbox = null } = {}) {
  return new Promise((resolve) => {
    let child;
    const isWin = process.platform === 'win32';
    try {
      let file = isWin ? 'powershell.exe' : '/bin/bash';
      let args = isWin ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command];
      if (sandbox) {
        const bw = findBwrap();
        if (!bw) { resolve('Hata: sandbox açık ama bubblewrap (bwrap) kurulu değil. Komut çalıştırılmadı.'); return; }
        file = bw;
        args = [...bwrapArgs(cwd, sandbox), '/bin/bash', '-c', command];
      }
      // stdin kapalı: etkileşimli komutlar sonsuza kadar beklemez.
      child = spawn(file, args, { cwd, env: sanitizedEnv(), detached: !isWin, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve(`Hata: komut başlatılamadı: ${e.message}`);
      return;
    }

    let stdout = '', stderr = '', total = 0, why = null, finished = false;
    const kill = (reason) => {
      why ??= reason;
      if (isWin && child.pid) {
        try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* yok */ }
      }
      try { if (!isWin) process.kill(-child.pid, 'SIGKILL'); } catch { /* yok */ }
      try { child.kill('SIGKILL'); } catch { /* zaten bitti */ }
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

module.exports = { runCommand, sandboxAvailable, bwrapArgs, sanitizedEnv };
