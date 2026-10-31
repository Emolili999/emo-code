const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { requestPinned, requestPinnedPost, parseSearchResults } = require('../lib/webfetch');
const { streamCompletion } = require('../lib/openrouter');
const { getShellSession, closeAllShellSessions, closeAllBackgroundJobs } = require('../lib/exec');
const { executeTool, runSubagentExplore, MAX_SUBAGENT_REQUESTS } = require('../lib/tools');

const listen = (handler) => new Promise((resolve) => {
  const srv = http.createServer(handler);
  srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
});
const LOCAL = [{ address: '127.0.0.1', family: 4 }];

test('webfetch: requestPinned GET ve requestPinnedPost ({all:true} lookup yolu)', async () => {
  const { srv, port } = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`${req.method}:${body}`); });
  });
  try {
    const url = new URL(`http://pinned.invalid:${port}/x`);
    const g = await requestPinned(url, LOCAL, { maxBytes: 10000 });
    assert.equal(g.status, 200);
    assert.match(String(g.body ?? g.text ?? ''), /GET:/);
    const p = await requestPinnedPost(url, LOCAL, { body: 'q=merhaba' });
    assert.match(String(p), /POST:q=merhaba/);
  } finally { srv.close(); }
});

test('web_search sonuç ayrıştırma: yönlendirme bağlantıları çözülür, güvensiz ve fazla sonuçlar atılır', () => {
  const html = [
    '<div class="result"><a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fone">Bir &amp; İki</a><a class="result__snippet">Özet &amp; bilgi</a></div>',
    '<div class="result"><a class="result__a" href="javascript:alert(1)">Güvensiz</a></div>',
    '<div class="result"><a class="result__a" href="https://example.org/two">İkinci</a><div class="result__snippet">Kısa özet</div></div>'
  ].join('');
  assert.deepEqual(parseSearchResults(html, 1), [{
    title: 'Bir & İki', url: 'https://example.com/one', snippet: 'Özet & bilgi'
  }]);
  assert.deepEqual(parseSearchResults(html, 6).map((result) => result.url), [
    'https://example.com/one', 'https://example.org/two'
  ]);
});

function sse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end('data: [DONE]\n\n');
}

test('openrouter: max_tokens gövdede, finish_reason length yarım araç çağrısını düşürür', async () => {
  let seen;
  const { srv, port } = await listen((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      seen = JSON.parse(b);
      sse(res, [
        { choices: [{ delta: { content: 'yarım', tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"path":"a' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'length' }] }
      ]);
    });
  });
  try {
    const r = await streamCompletion({
      apiKey: 'k', model: 'm', ac: new AbortController(), send: () => {}, maxTokens: 777,
      messages: [{ role: 'user', content: 'x' }], endpoint: `http://127.0.0.1:${port}/`
    });
    assert.equal(seen.max_tokens, 777);
    assert.equal(r.truncated, true);
    assert.equal(r.msg.truncated, true);
    assert.ok(!r.msg.tool_calls?.length);
    assert.ok(r.msg.droppedToolCalls >= 1);
  } finally { srv.close(); }
});

test('openrouter: 429 sonrası yeniden dener', async () => {
  let n = 0;
  const { srv, port } = await listen((req, res) => {
    req.resume();
    req.on('end', () => {
      n++;
      if (n === 1) { res.writeHead(429, { 'retry-after': '0' }); res.end('{"error":{"message":"yavaş"}}'); return; }
      sse(res, [{ choices: [{ delta: { content: 'tamam' }, finish_reason: 'stop' }] }]);
    });
  });
  try {
    const r = await streamCompletion({
      apiKey: 'k', model: 'm', ac: new AbortController(), send: () => {},
      messages: [{ role: 'user', content: 'x' }], endpoint: `http://127.0.0.1:${port}/`
    });
    assert.equal(n, 2);
    assert.equal(r.msg.content, 'tamam');
  } finally { srv.close(); }
});

test('shell_session: cwd ve env komutlar arasında korunur', async () => {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sh-')));
  fs.mkdirSync(path.join(ws, 'alt'));
  const s = getShellSession({ cwd: ws, sandbox: null });
  try {
    await s.execOnce('cd alt && export EMO_X=42', { timeoutMs: 5000 });
    const r = await s.execOnce('pwd; echo $EMO_X', { timeoutMs: 5000 });
    assert.match(r.output, new RegExp(`${ws}/alt\\n42`));
  } finally { closeAllShellSessions(); }
});

test('background_process: başlat, çıktı oku, listele ve durdur', async (t) => {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bg-')));
  const { createApprovals } = require('../lib/approvals');
  const ctx = {
    workspace: ws, settings: { autoApprove: true }, chatId: 'bg-test',
    approvals: createApprovals(), ac: new AbortController(), send: () => {}
  };
  t.after(() => closeAllBackgroundJobs());
  try {
    const started = await executeTool('background_process', { action: 'start', command: 'printf harness-background; sleep 30' }, ctx);
    const id = /başlatıldı:\s*(bg\d+)/.exec(started)?.[1];
    assert.ok(id, started);
    assert.match(await executeTool('background_process', { action: 'list' }, ctx), new RegExp(id));

    let output = '';
    for (let i = 0; i < 30 && !output.includes('harness-background'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      output = await executeTool('background_process', { action: 'output', id }, ctx);
    }
    assert.match(output, /harness-background/);
    assert.match(await executeTool('background_process', { action: 'stop', id }, ctx), new RegExp(id));
    assert.match(await executeTool('background_process', { action: 'output', id: 'missing' }, ctx), /iş bulunamadı/);
  } finally {
    closeAllBackgroundJobs();
  }
});

test('search_files: context satırları', async () => {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sf-')));
  fs.writeFileSync(path.join(ws, 'a.txt'), 'önce\nhedef\nsonra\nuzak\n');
  const { createApprovals } = require('../lib/approvals');
  const ctx = { workspace: ws, settings: {}, chatId: 't', approvals: createApprovals(), ac: new AbortController(), send: () => {} };
  const out = await executeTool('search_files', { pattern: 'hedef', context: 1 }, ctx);
  assert.match(out, /önce/);
  assert.match(out, /sonra/);
  assert.ok(!/uzak/.test(out));
});

test('subagent: istek bütçesi dolunca model çağrılmaz', async () => {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-')));
  let calls = 0;
  const ctx = {
    workspace: ws, apiKey: 'k', mainModel: 'm', settings: {}, ac: new AbortController(), send: () => {},
    subagentState: { requests: MAX_SUBAGENT_REQUESTS, cost: 0 },
    completionFn: async () => { calls++; return { msg: { role: 'assistant', content: 'x' } }; }
  };
  const out = await runSubagentExplore({ task: 'bak' }, ctx);
  assert.match(out, /bütçesi doldu/);
  assert.equal(calls, 0);
});
