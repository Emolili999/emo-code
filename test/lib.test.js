const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('node:net');

const { lineDiff, detailedDiff } = require('../lib/diff');
const { globFiles, globToRegex } = require('../lib/glob');
const ctx = require('../lib/context');
const { isPrivateAddress, assertPublicUrl, htmlToText } = require('../lib/webfetch');
const { runCommand, bwrapArgs, sanitizedEnv, sandboxAvailable } = require('../lib/exec');
const store = require('../lib/store');
const { createCheckpoints } = require('../lib/checkpoints');
const { createApprovals } = require('../lib/approvals');
const { commandSessionKey } = require('../lib/tools');
const { loadProjectInstructions, mergeProgressSection, PROGRESS_START, PROGRESS_END } = require('../lib/prompt');
const { streamCompletion } = require('../lib/openrouter');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orc-'));

test('diff: eklenen/silinen satırlar ve bağlam', () => {
  const out = lineDiff('a\nb\nc\nd\ne\nf\ng\nh\ni\nj', 'a\nb\nc\nd\nE\nf\ng\nh\ni\nj', 1);
  assert.match(out, /^…$/m);
  assert.match(out, /^- e$/m);
  assert.match(out, /^\+ E$/m);
  assert.equal(lineDiff('x', 'x'), '(değişiklik yok)');
  assert.match(lineDiff('', 'yeni'), /^\+ yeni$/m);
});

test('glob: desenler', () => {
  assert.ok(globToRegex('**/*.js').test('a/b/c.js'));
  assert.ok(globToRegex('**/*.js').test('c.js'));
  assert.ok(globToRegex('src/*.{ts,tsx}').test('src/a.tsx'));
  assert.ok(!globToRegex('*.js').test('a/b.js'));
  const d = tmp();
  fs.mkdirSync(path.join(d, 'src/deep'), { recursive: true });
  fs.mkdirSync(path.join(d, 'node_modules/x'), { recursive: true });
  for (const f of ['a.js', 'src/b.js', 'src/deep/c.js', 'src/d.txt', 'node_modules/x/e.js']) fs.writeFileSync(path.join(d, f), '');
  const skip = (full, isDir) => isDir && path.basename(full) === 'node_modules';
  assert.deepEqual(globFiles(d, '**/*.js', { skip }).files, ['a.js', 'src/b.js', 'src/deep/c.js']);
  assert.deepEqual(globFiles(d, '*.txt', { skip }).files, ['src/d.txt']);
  assert.deepEqual(globFiles(d, 'src/*.js', { skip }).files, ['src/b.js']);
});

test('context: eski tool çıktıları kısaltılır, tool çiftleri onarılır', () => {
  const big = 'x'.repeat(10000);
  const msgs = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: '', tool_calls: [{ id: '1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: '1', content: big },
    ...Array.from({ length: 12 }, (_, i) => ({ role: 'user', content: String(i) }))
  ];
  const c = ctx.compactHistory(msgs, { keepRecent: 10, toolLimit: 100 });
  assert.ok(c[2].content.length < 200);
  assert.equal(msgs[2].content.length, 10000); // orijinal değişmez
  assert.ok(ctx.fitHistory(msgs, 500).length === msgs.length);

  const broken = [{ role: 'assistant', content: '', tool_calls: [{ id: 'z', type: 'function', function: { name: 'x', arguments: '{}' } }] }];
  const fixed = ctx.repairToolPairs(broken);
  assert.equal(fixed[1].role, 'tool');
  assert.equal(fixed[1].tool_call_id, 'z');
});

test('context: prepareForApi arayüz alanlarını ve yetim tool mesajlarını ayıklar', () => {
  const out = ctx.prepareForApi([
    { role: 'notice', content: 'gizli' },
    { role: 'notice', content: 'özet', forModel: true },
    { role: 'assistant', content: 'merhaba', reasoning: 'düşünce' },
    { role: 'assistant', content: '' },
    { role: 'tool', tool_call_id: 'orphan_123', content: 'yetim yanıt' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'valid_1', type: 'function', function: { name: 'glob', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'valid_1', content: 'a.js' }
  ]);
  assert.equal(out.length, 4);
  assert.equal(out[0].role, 'user');
  assert.equal(out[1].reasoning, undefined);
  assert.equal(out[2].role, 'assistant');
  assert.equal(out[3].role, 'tool');
  assert.equal(out[3].tool_call_id, 'valid_1');
});

test('webfetch: yerel ve özel adresler reddedilir', async () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:c0a8:101', '2001:db8::1', '2001:0::1', '2002:a9fe:a9fe::1', '192.0.2.1', '198.18.0.1', '0.0.0.0']) {
    assert.ok(isPrivateAddress(ip), ip);
  }
  assert.ok(!isPrivateAddress('93.184.216.34'));
  assert.ok(!isPrivateAddress('2001:4860:4860::8888'));
  assert.ok(!isPrivateAddress('::ffff:5db8:d822')); // IPv4-mapped public address
  for (const u of ['http://localhost/x', 'http://127.0.0.1:8080', 'http://[::1]/', 'file:///etc/passwd', 'ftp://x.com', 'http://u:p@example.com', 'http://169.254.169.254/latest']) {
    await assert.rejects(() => assertPublicUrl(u), u);
  }
  assert.equal(htmlToText('<html><script>alert(1)</script><p>Merhaba &amp; dünya</p></html>'), 'Merhaba & dünya');
});

test('OpenRouter akışı: durdurulunca kısmi metin korunur, yarım araç çağrısı çalıştırılmaz', async () => {
  const originalFetch = global.fetch;
  const ac = new AbortController();
  const encoder = new TextEncoder();
  global.fetch = async () => ({
    ok: true,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"kısmi yanıt"}}]}\n\n'));
        ac.signal.addEventListener('abort', () => {
          try { controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })); } catch { /* stream zaten kapanmış olabilir */ }
        }, { once: true });
      }
    }),
    headers: { get: () => null }
  });
  try {
    const result = await streamCompletion({
      apiKey: 'test', model: 'test/model', messages: [], tools: [], ac,
      send: (type) => { if (type === 'delta') ac.abort(); }
    });
    assert.equal(result.aborted, true);
    assert.equal(result.msg.content, 'kısmi yanıt');
    assert.equal(result.msg.tool_calls, undefined);
  } finally {
    global.fetch = originalFetch;
  }
});

test('exec: çıktı, çıkış kodu, zaman aşımı ve durdurma', async () => {
  const d = tmp();
  assert.equal(await runCommand('echo selam', { cwd: d }), 'selam');
  assert.match(await runCommand('echo hata >&2; exit 3', { cwd: d }), /\[stderr\]\nhata[\s\S]*çıkış kodu: 3/);
  const t0 = Date.now();
  assert.match(await runCommand('sleep 10', { cwd: d, timeoutMs: 300 }), /zaman aşımı/);
  assert.ok(Date.now() - t0 < 3000);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  assert.match(await runCommand('sleep 10', { cwd: d, signal: ac.signal }), /durduruldu/);
  const chunks = [];
  await runCommand('echo a; echo b', { cwd: d, onData: (s) => chunks.push(s) });
  assert.ok(chunks.join('').includes('a'));
  // stdin kapalı: okuyan komut takılmaz
  assert.match(await runCommand('cat; echo bitti', { cwd: d, timeoutMs: 3000 }), /bitti/);
  // Çok baytlı UTF-8 karakterin baytları ayrı çıktılarda gelse de bozulmaz.
  // Alt süreçte Node başlatmaya bağlı kalmamak için printf ile iki bayta böl.
  const utf8Out = await runCommand("printf '\\304'; sleep 0.02; printf '\\237'", { cwd: d });
  assert.equal(utf8Out, 'ğ');
});

test('exec: bwrap argümanları ağı, /run dizinini, ortam değişkenlerini ve ev dizinini yalıtır', () => {
  const a = bwrapArgs('/w/p', { network: false });
  assert.ok(a.includes('--unshare-net'));
  assert.ok(a.includes('--clearenv'));
  assert.ok(a.join(' ').includes('--tmpfs /run'));
  assert.ok(a.join(' ').includes(`--tmpfs ${os.homedir()}`));
  assert.ok(!bwrapArgs('/w/p', { network: true }).includes('--unshare-net'));
  const env = sanitizedEnv({ PATH: '/usr/bin', OPENROUTER_API_KEY: 'gizli', GEMINI_API_KEY: 'gizli2', SSH_AUTH_SOCK: '/run/ssh', MY_SECRET: 'x', NORMAL_VAR: '1' });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.NORMAL_VAR, '1');
  assert.equal(env.OPENROUTER_API_KEY, undefined);
  assert.equal(env.GEMINI_API_KEY, undefined);
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.equal(env.MY_SECRET, undefined);
});

test('exec: bubblewrap çalışma klasörünü kalıcı yazar, geçici /tmp yazısını dışarı sızdırmaz', async (t) => {
  if (!sandboxAvailable()) return t.skip('bubblewrap kurulu değil');
  const ws = tmp();
  const escaped = path.join(path.dirname(ws), `${path.basename(ws)}-outside.txt`);
  const quote = (value) => `'${value.replace(/'/g, "'\\''")}'`;
  try {
    const out = await runCommand(
      `printf kaçış > ${quote(escaped)}; printf içeride > inside.txt`,
      { cwd: ws, sandbox: { network: true }, timeoutMs: 5000 }
    );
    assert.equal(fs.readFileSync(path.join(ws, 'inside.txt'), 'utf8'), 'içeride');
    assert.equal(fs.existsSync(escaped), false);
    assert.equal(out, '(çıktı yok)');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(escaped, { force: true });
  }
});

test('exec: ağ kapalı bubblewrap ana makinedeki yerel porta erişemez', async (t) => {
  if (!sandboxAvailable()) return t.skip('bubblewrap kurulu değil');
  const server = net.createServer((socket) => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    server.close();
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      return t.skip('bu ortam yerel test sunucusu açmaya izin vermiyor');
    }
    throw error;
  }
  const port = server.address().port;
  try {
    const result = await runCommand(
      `timeout 2 bash -c 'echo test > /dev/tcp/127.0.0.1/${port}'`,
      { cwd: tmp(), sandbox: { network: false }, timeoutMs: 4000 }
    );
    if (/NETLINK_ROUTE|Operation not permitted/.test(result)) {
      return t.skip('bu ortam bubblewrap ağ ad alanı oluşturmayı engelliyor');
    }
    assert.equal(result.includes('[çıkış kodu: 0]'), false, result);
    assert.match(result, /çıkış kodu:|No route|Network is unreachable|Connection refused/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('store: atomik yazma, bozuk dosyada yedekten okuma', () => {
  const d = tmp();
  const f = path.join(d, 'a.json');
  store.writeJSON(f, { v: 1 }, { backup: true });
  store.writeJSON(f, { v: 2 }, { backup: true });
  assert.deepEqual(store.readJSON(f, null), { v: 2 });
  fs.writeFileSync(f, '{bozuk');
  assert.deepEqual(store.readJSON(f, null), { v: 1 });
  assert.equal(store.readJSON(path.join(d, 'yok.json'), 'x'), 'x');
  assert.equal(fs.readdirSync(d).filter((n) => n.endsWith('.tmp')).length, 0);

  const u = path.join(d, 'k.sh');
  fs.writeFileSync(u, 'a', { mode: 0o755 });
  store.atomicWrite(u, 'b');
  assert.equal(fs.readFileSync(u, 'utf8'), 'b');
  assert.equal(fs.statSync(u).mode & 0o777, 0o755);
});

test('checkpoints: değişiklikler geri alınır', () => {
  const ws = fs.realpathSync(tmp());
  const cp = createCheckpoints(tmp());
  fs.writeFileSync(path.join(ws, 'a.txt'), 'eski');
  const run = cp.begin();
  cp.record('c1', run, ws, path.join(ws, 'a.txt'));
  fs.writeFileSync(path.join(ws, 'a.txt'), 'yeni');
  cp.record('c1', run, ws, path.join(ws, 'a.txt')); // ikinci kayıt ilk yedeği bozmaz
  cp.record('c1', run, ws, path.join(ws, 'b.txt'));
  fs.writeFileSync(path.join(ws, 'b.txt'), 'oluşturuldu');
  assert.deepEqual(cp.summary('c1'), { runs: 1, files: 2 });
  const r = cp.undoLast('c1');
  assert.ok(r.ok);
  assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'eski');
  assert.ok(!fs.existsSync(path.join(ws, 'b.txt')));
  assert.equal(cp.undoLast('c1').ok, false);
});

test('checkpoints: ikili dosyalar bayt ve izin bilgisi korunarak geri alınır', () => {
  const ws = fs.realpathSync(tmp());
  const cp = createCheckpoints(tmp());
  const file = path.join(ws, 'image.bin');
  const original = Buffer.from([0, 255, 1, 128, 0, 42]);
  fs.writeFileSync(file, original, { mode: 0o640 });
  const run = cp.begin();
  cp.record('binary', run, ws, file);
  fs.writeFileSync(file, Buffer.from([9, 9, 9]));
  const r = cp.undoLast('binary');
  assert.ok(r.ok);
  assert.deepEqual(fs.readFileSync(file), original);
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
});

test('checkpoints: komut farkları ekleme, silme ve ikili değişikliği geri alır', () => {
  const ws = fs.realpathSync(tmp());
  const cp = createCheckpoints(tmp());
  const oldFile = path.join(ws, 'old.txt');
  const goneFile = path.join(ws, 'gone.txt');
  const binFile = path.join(ws, 'icon.bin');
  fs.writeFileSync(oldFile, 'önceki');
  fs.writeFileSync(goneFile, 'silinmemeli');
  const originalBin = Buffer.from([0, 254, 255, 7]);
  fs.writeFileSync(binFile, originalBin);
  const run = cp.begin();
  const before = cp.snapshotWorkspace(ws);
  fs.writeFileSync(oldFile, 'sonraki');
  fs.unlinkSync(goneFile);
  fs.writeFileSync(binFile, Buffer.from([8, 8, 8]));
  fs.writeFileSync(path.join(ws, 'new.txt'), 'yeni dosya');
  const result = cp.recordWorkspaceChanges('cmd', run, ws, before);
  assert.equal(result.changed, 4);
  const undo = cp.undoLast('cmd');
  assert.ok(undo.ok);
  assert.equal(fs.readFileSync(oldFile, 'utf8'), 'önceki');
  assert.equal(fs.readFileSync(goneFile, 'utf8'), 'silinmemeli');
  assert.deepEqual(fs.readFileSync(binFile), originalBin);
  assert.ok(!fs.existsSync(path.join(ws, 'new.txt')));

  // Gizli anahtarlar checkpoint yedeklerine kopyalanmaz ve dışarıyı gösteren symlink geri yüklenmez
  fs.writeFileSync(path.join(ws, 'id_rsa'), 'PRIVATE_KEY');
  const snap = cp.snapshotWorkspace(ws);
  assert.equal(snap.files.has('id_rsa'), false);
  cp.record('sec', cp.begin(), ws, path.join(ws, 'id_rsa'));
  assert.equal(cp.summary('sec').files, 0);
});

test('approvals: oturum izni yalnızca force olmayanlar için geçerli', async () => {
  const ap = createApprovals();
  const events = [];
  const send = (type, d) => { events.push({ type, ...d }); };
  const ac = new AbortController();
  const base = { send, ac, settings: {}, chatId: 'c' };

  let p = ap.approve({ ...base, title: 't', detail: 'd', sessionKey: 'edit', sessionLabel: 'hep' });
  ap.respond(events.at(-1).id, 'allow_session');
  assert.equal(await p, true);
  const n = events.length;
  assert.equal(await ap.approve({ ...base, title: 't', detail: 'd', sessionKey: 'edit' }), true);
  assert.equal(events.length, n); // sormadan geçti

  p = ap.approve({ ...base, title: 't', detail: 'd', sessionKey: 'edit', force: true, warning: 'riskli' });
  assert.equal(events.at(-1).sessionLabel, null);
  ap.respond(events.at(-1).id, 'allow_session'); // force: oturum izni yok sayılır
  assert.equal(await p, false);

  p = ap.approve({ ...base, title: 't', detail: 'd' });
  ap.respond(events.at(-1).id, 'deny');
  assert.equal(await p, false);

  const ac2 = new AbortController();
  p = ap.approve({ ...base, ac: ac2, title: 't', detail: 'd' });
  ac2.abort();
  assert.equal(await p, false);

  const q = ap.ask({ send, ac, question: '?', options: [] });
  ap.respond(events.at(-1).id, 'evet');
  assert.equal(await q, 'evet');
});

test('approvals: kademeli izin modları (sıkı, normal, oto, turbo)', async () => {
  const ap = createApprovals();
  const events = [];
  const send = (type, d) => { events.push({ type, ...d }); };
  const ac = new AbortController();

  // 1. Turbo Modu: tüm kodlara izin ver (riskli ve force olsa bile sormadan geçer)
  const turboBase = { send, ac, settings: { permissionMode: 'turbo' }, chatId: 'turbo-chat' };
  const turbo1 = await ap.approve({ ...turboBase, title: 'rm -rf', detail: 'sil', force: true, warning: 'Çok riskli' });
  assert.equal(turbo1, true);
  assert.equal(events.length, 0); // Hiç onay sormadı

  // 2. Oto Modu: kendin karar ver (güvenli kodlar sormadan geçer, riskli kodlarda sorar)
  const autoBase = { send, ac, settings: { permissionMode: 'auto' }, chatId: 'auto-chat' };
  const autoSafe = await ap.approve({ ...autoBase, title: 'güvenli', detail: 'test' });
  assert.equal(autoSafe, true);
  assert.equal(events.length, 0); // Güvenli işlem doğrudan geçti

  // Oto Modunda riskli işlem gelince sorar
  const autoRiskyPromise = ap.approve({ ...autoBase, title: 'riskli', detail: 'rm', force: true, warning: 'Riskli komut' });
  assert.equal(events.length, 1);
  assert.equal(events[0].mode, 'auto');
  assert.equal(events[0].warning, 'Riskli komut');
  ap.respond(events[0].id, 'allow');
  assert.equal(await autoRiskyPromise, true);

  // 3. Normal Mod: riskli kodlarda uyarı ver, güvenlilerde oturum izni sun
  const normalBase = { send, ac, settings: { permissionMode: 'normal' }, chatId: 'normal-chat' };
  events.length = 0;
  // Güvenli işlem ilk kez sorulur ve sessionLabel verilir
  const norm1Promise = ap.approve({ ...normalBase, title: 'derle', detail: 'make', sessionKey: 'cmd:make', sessionLabel: 'make komutuna hep izin ver' });
  assert.equal(events.length, 1);
  assert.equal(events[0].mode, 'normal');
  assert.equal(events[0].sessionLabel, 'make komutuna hep izin ver');
  ap.respond(events[0].id, 'allow_session');
  assert.equal(await norm1Promise, true);

  // Oturum izni alındıktan sonra güvenli işlem tekrar sorulmaz
  const normRepeat = await ap.approve({ ...normalBase, title: 'derle', detail: 'make', sessionKey: 'cmd:make' });
  assert.equal(normRepeat, true);
  assert.equal(events.length, 1); // yeni event eklenmedi

  // Riskli işlem gelince oturum izni geçersizdir, mutlaka sorulur ve uyarı verilir
  const normRiskyPromise = ap.approve({ ...normalBase, title: 'sudo', detail: 'sudo apt', force: true, warning: 'Sistem komutu', sessionKey: 'cmd:sudo' });
  assert.equal(events.length, 2);
  assert.equal(events[1].warning, 'Sistem komutu');
  assert.equal(events[1].sessionLabel, null); // sessionLabel yok
  ap.respond(events[1].id, 'allow');
  assert.equal(await normRiskyPromise, true);

  // 4. Sıkı Mod: her komudu sor (oturum izni ile atlamaz)
  const strictBase = { send, ac, settings: { permissionMode: 'strict' }, chatId: 'strict-chat' };
  events.length = 0;
  const strict1Promise = ap.approve({ ...strictBase, title: 'ls', detail: 'ls -la', sessionKey: 'cmd:ls', sessionLabel: 'hep izin ver' });
  assert.equal(events.length, 1);
  assert.equal(events[0].mode, 'strict');
  assert.equal(events[0].sessionLabel, null); // Sıkı modda session sunulmaz
  ap.respond(events[0].id, 'allow');
  assert.equal(await strict1Promise, true);

  // Tekrar aynı komut gelse bile Sıkı modda YİNE sorulur
  const strict2Promise = ap.approve({ ...strictBase, title: 'ls', detail: 'ls -la', sessionKey: 'cmd:ls' });
  assert.equal(events.length, 2); // 2. kez de sordu!
  ap.respond(events[1].id, 'allow');
  assert.equal(await strict2Promise, true);
});

test('tools: komut oturum anahtarı bileşik komutlarda yok', () => {
  assert.equal(commandSessionKey('npm test'), 'cmd:npm test');
  assert.equal(commandSessionKey('npm test && rm x'), null);
  assert.equal(commandSessionKey('echo $(whoami)'), null);
  assert.equal(commandSessionKey('ls > out'), null);
});

test('prompt: proje talimatı okunur, dışarıyı gösteren symlink yok sayılır', () => {
  const ws = tmp();
  assert.equal(loadProjectInstructions(ws), null);
  fs.writeFileSync(path.join(ws, 'OR.md'), '# Kurallar\nTürkçe yaz');
  assert.match(loadProjectInstructions(ws).text, /Türkçe yaz/);
  const ws2 = tmp();
  const secret = path.join(tmp(), 'gizli.md');
  fs.writeFileSync(secret, 'SIR');
  fs.symlinkSync(secret, path.join(ws2, 'OR.md'));
  assert.equal(loadProjectInstructions(ws2), null);
});

test('detailedDiff: satır numaraları, eklenen ve silinen sayıları', () => {
  const d = detailedDiff('satir1\neski_satir\nsatir3', 'satir1\nyeni_satir\nsatir3\nek_satir');
  assert.equal(d.additions, 2);
  assert.equal(d.deletions, 1);
  assert.equal(d.lines.some((l) => l.type === 'del' && l.text === 'eski_satir'), true);
  assert.equal(d.lines.some((l) => l.type === 'add' && l.text === 'yeni_satir'), true);
  assert.equal(d.lines.some((l) => l.type === 'add' && l.text === 'ek_satir'), true);
});

test('checkpoints: getChangesDetails ve undoFile ile tekil dosya geri alma', () => {
  const ws = tmp();
  const cpDir = tmp();
  const cp = createCheckpoints(cpDir);
  const chatId = 'chat-diff-test';
  const fileA = path.join(ws, 'a.txt');
  const fileB = path.join(ws, 'b.txt');

  fs.writeFileSync(fileA, 'orijinal a');
  fs.writeFileSync(fileB, 'orijinal b');

  const runId = cp.begin();
  cp.record(chatId, runId, ws, fileA);
  fs.writeFileSync(fileA, 'degisti a\nyeni satir');

  cp.record(chatId, runId, ws, fileB);
  fs.writeFileSync(fileB, 'degisti b');

  const details = cp.getChangesDetails(chatId);
  assert.equal(details.totalFiles, 2);
  assert.equal(details.files.length, 2);
  const aInfo = details.files.find((f) => f.relativePath === 'a.txt');
  assert.ok(aInfo);
  assert.equal(aInfo.status, 'modified');
  assert.ok(aInfo.additions >= 1);

  // Tekil dosya geri alma (yalnızca fileA geri alınsın, fileB değişmiş kalsın)
  const undoRes = cp.undoFile(chatId, fileA);
  assert.equal(undoRes.ok, true);
  assert.equal(fs.readFileSync(fileA, 'utf8'), 'orijinal a');
  assert.equal(fs.readFileSync(fileB, 'utf8'), 'degisti b');

  const afterDetails = cp.getChangesDetails(chatId);
  assert.equal(afterDetails.totalFiles, 1);
  assert.equal(afterDetails.files[0].relativePath, 'b.txt');

  // Birden fazla çalışmada (multi-run) değişen dosyanın en ilk haline dönmesi ve undoAll
  const run2 = cp.begin();
  cp.record(chatId, run2, ws, fileB);
  fs.writeFileSync(fileB, 'degisti b v2');
  const fileC = path.join(ws, 'c.txt');
  cp.record(chatId, run2, ws, fileC);
  fs.writeFileSync(fileC, 'yeni c');

  const undoB = cp.undoFile(chatId, fileB);
  assert.equal(undoB.ok, true);
  assert.equal(fs.readFileSync(fileB, 'utf8'), 'orijinal b');
  assert.equal(cp.getChangesDetails(chatId).totalFiles, 1);

  const undoAllRes = cp.undoAll(chatId);
  assert.equal(undoAllRes.ok, true);
  assert.equal(fs.existsSync(fileC), false);
  assert.equal(cp.summary(chatId).runs, 0);
});

test('prompt: mergeProgressSection EMO.md kurallarını bozmadan ilerleme özetini günceller ve uzun dosyada korur', () => {
  const ws = tmp();
  const baseRules = '# Proje Kuralları\n- Her zaman test yaz.\n- Kod stilini koru.';
  const firstMerged = mergeProgressSection(baseRules, '### 1. Yapılan İşlemler\n- Subagent eklendi\n### 3. Kalınan Yer\n- AppImage derlenecek', 30);
  assert.ok(firstMerged.includes('# Proje Kuralları'));
  assert.ok(firstMerged.includes(PROGRESS_START));
  assert.ok(firstMerged.includes('30. adım'));
  assert.ok(firstMerged.includes('Subagent eklendi'));
  assert.ok(firstMerged.includes(PROGRESS_END));

  // İkinci kez güncellendiğinde eski ilerleme bloğu yenisiyle değişir, üstteki kurallar korunur
  const secondMerged = mergeProgressSection(firstMerged, '### 1. Yapılan İşlemler\n- AppImage tamamlandı\n### 3. Kalınan Yer\n- Testler bitti', 60);
  assert.ok(secondMerged.includes('# Proje Kuralları'));
  assert.ok(!secondMerged.includes('Subagent eklendi'));
  assert.ok(secondMerged.includes('AppImage tamamlandı'));
  assert.ok(secondMerged.includes('60. adım'));
  assert.equal(secondMerged.split(PROGRESS_START).length - 1, 1);

  // Çok uzun EMO.md dosyasında bile ilerleme özeti kırpılıp kaybolmaz
  const hugeRules = '# Kurallar\n' + 'Kural satırı detayları. '.repeat(500);
  const hugeWithProgress = mergeProgressSection(hugeRules, 'KRITIK_KALINAN_YER_BILGISI', 90);
  fs.writeFileSync(path.join(ws, 'EMO.md'), hugeWithProgress);
  const loaded = loadProjectInstructions(ws);
  assert.ok(loaded);
  assert.equal(loaded.name, 'EMO.md');
  assert.ok(loaded.text.includes('KRITIK_KALINAN_YER_BILGISI'));
});
