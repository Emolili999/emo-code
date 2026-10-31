const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const enabled = process.env.EMOCODE_UI_SMOKE === '1';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForPage(child, userData, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Electron erken kapandı (çıkış kodu: ${child.exitCode}).\n${child.bootLogs || ''}`);
    try {
      const activeFile = path.join(userData, 'DevToolsActivePort');
      const [portLine] = fs.readFileSync(activeFile, 'utf8').trim().split('\n');
      const response = await fetch(`http://127.0.0.1:${portLine}/json/list`, { signal: AbortSignal.timeout(1000) });
      const pages = await response.json();
      const page = pages.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* DevTools henüz başlamadı */ }
    await wait(150);
  }
  throw new Error(`Electron penceresi zamanında başlamadı.\n${child.bootLogs || ''}`);
}

function connectCdp(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let id = 0;
  let closed = false;
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject, timer } = pending.get(message.id);
    clearTimeout(timer);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  socket.addEventListener('close', () => {
    closed = true;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error('DevTools bağlantısı kapandı.'));
    }
    pending.clear();
  });

  return {
    socket,
    async call(method, params = {}, timeoutMs = 10000) {
      await opened;
      if (closed) throw new Error('DevTools bağlantısı kapalı.');
      const requestId = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`DevTools çağrısı zaman aşımına uğradı: ${method}`));
        }, timeoutMs);
        pending.set(requestId, { resolve, reject, timer });
        socket.send(JSON.stringify({ id: requestId, method, params }));
      });
    }
  };
}

function startElectron(electronPath, root, userData, temp, mockPath) {
  const requireMock = `--require=${JSON.stringify(mockPath)}`;
  const nodeOptions = [process.env.NODE_OPTIONS, requireMock].filter(Boolean).join(' ');
  const child = spawn(electronPath, [
    '--no-sandbox', '--disable-gpu', '--headless', '--remote-debugging-port=0',
    `--user-data-dir=${userData}`, '.'
  ], {
    cwd: root,
    env: {
      ...process.env,
      NODE_OPTIONS: nodeOptions,
      EMOCODE_MOCK_OPENROUTER: '1',
      HOME: temp,
      XDG_CONFIG_HOME: path.join(temp, 'config'),
      XDG_CACHE_HOME: path.join(temp, 'cache'),
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  child.bootLogs = '';
  child.stderr.on('data', (chunk) => { child.bootLogs += chunk.toString(); });
  return child;
}

async function stopElectron(child, cdp) {
  cdp?.socket.close();
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      wait(3000).then(() => { if (child.exitCode === null) child.kill('SIGKILL'); })
    ]);
  }
}

async function evaluate(cdp, expression) {
  const response = await cdp.call('Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression
  }, 45000);
  assert.equal(response.exceptionDetails, undefined, response.exceptionDetails?.text);
  return response.result.value;
}

test('Electron UI: gönderim, yanıt, ayar ve sohbet yeniden başlatma sonrası korunur', {
  skip: !enabled,
  timeout: 90000
}, async (t) => {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'emocode-ui-'));
  const userData = path.join(temp, 'user-data');
  const mockPath = path.join(__dirname, 'fixtures', 'mock-openrouter.cjs');
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  const expectedTitle = /<title>(.*?)<\/title>/s.exec(html)?.[1];
  fs.mkdirSync(userData, { recursive: true });
  const electronPath = require('electron');
  let child;
  let cdp;
  t.after(async () => {
    await stopElectron(child, cdp);
    fs.rmSync(temp, { recursive: true, force: true });
  });

  child = startElectron(electronPath, root, userData, temp, mockPath);
  let page = await waitForPage(child, userData);
  cdp = connectCdp(page.webSocketDebuggerUrl);
  await cdp.call('Runtime.enable');
  const first = await evaluate(cdp, `(async () => {
    const started = Date.now();
    await new Promise((resolve, reject) => {
      const check = () => {
        if (document.readyState === 'complete' && window.api && document.querySelector('#input')) resolve();
        else if (Date.now() - started > 10000) reject(new Error('renderer başlangıcı zaman aşımına uğradı'));
        else setTimeout(check, 50);
      };
      check();
    });

    const title = document.title;
    const input = document.querySelector('#input');
    input.value = 'API anahtarı olmadan gönderme';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#send').click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const missingKeyPromptsSettings = !document.querySelector('#modal').classList.contains('hidden');

    document.querySelector('#custom-prompt').value = 'electron-smoke-persisted-setting';
    document.querySelector('#api-key').value = 'sk-or-v1-ui-smoke';
    document.querySelector('#settings-save').click();
    const saveDeadline = Date.now() + 5000;
    while (!document.querySelector('#modal').classList.contains('hidden') && Date.now() < saveDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const settings = await window.api.getSettings();
    document.querySelector('#new-chat').click();
    const chatBeforeSend = (await window.api.loadChats())[0];

    const inputEl = document.querySelector('#input');
    inputEl.value = 'Harness hata akışı';
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#send').click();
    const errorDeadline = Date.now() + 10000;
    while (!document.querySelector('#messages').innerText.includes('Harness test 401') && Date.now() < errorDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const errorRendered = document.querySelector('#messages').innerText.includes('Harness test 401');
    const failedChat = (await window.api.loadChats()).find((chat) => chat.id === chatBeforeSend.id);

    inputEl.value = 'Harness durdurma akışı';
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#send').click();
    const partialDeadline = Date.now() + 10000;
    while (!document.querySelector('#messages').innerText.includes('Harness kısmi yanıtı') && Date.now() < partialDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const stopWasAvailable = document.querySelector('#send').classList.contains('stop');
    if (stopWasAvailable) document.querySelector('#send').click();
    const stoppedDeadline = Date.now() + 10000;
    while (document.querySelector('#send').classList.contains('stop') && Date.now() < stoppedDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const stopRecovered = !document.querySelector('#send').classList.contains('stop');
    const stoppedChat = (await window.api.loadChats()).find((chat) => chat.id === chatBeforeSend.id);

    inputEl.value = 'Harness gerçek gönderim';
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#send').click();
    const responseDeadline = Date.now() + 10000;
    while (!document.querySelector('#messages').innerText.includes('Harness yanıtı') && Date.now() < responseDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    let chats = [];
    const persistedDeadline = Date.now() + 5000;
    while (Date.now() < persistedDeadline) {
      chats = await window.api.loadChats();
      const sent = chats.find((chat) => chat.id === chatBeforeSend.id);
      if (sent?.messages.some((message) => message.role === 'assistant' && message.content === 'Harness yanıtı')) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const sentChat = chats.find((chat) => chat.id === chatBeforeSend.id);
    return {
      title,
      missingKeyPromptsSettings,
      input: !!inputEl,
      bridge: typeof window.api.send,
      hasApiKey: settings.hasApiKey,
      savedPrompt: settings.customPrompt,
      errorRendered,
      errorPersisted: failedChat?.lastError?.includes('OpenRouter 401') && failedChat.lastError.includes('Harness test 401'),
      stopWasAvailable,
      stopRecovered,
      abortDidNotBecomeError: stoppedChat?.lastError == null,
      assistantRendered: document.querySelector('#messages').innerText.includes('Harness yanıtı'),
      chatHasUserMessage: sentChat?.messages.some((message) => message.role === 'user' && String(message.content).includes('Harness gerçek gönderim')),
      chatHasAssistantMessage: sentChat?.messages.some((message) => message.role === 'assistant' && message.content === 'Harness yanıtı'),
      chatCount: chats.length
    };
  })()`);

  assert.equal(first.title, expectedTitle);
  assert.equal(first.input, true);
  assert.equal(first.bridge, 'function');
  assert.equal(first.missingKeyPromptsSettings, true, 'API anahtarı yokken gönderim ayarları açmalı');
  assert.equal(first.hasApiKey, true, 'API anahtarı ayarlar üzerinden kaydedilmeli');
  assert.equal(first.savedPrompt, 'electron-smoke-persisted-setting');
  assert.equal(first.errorRendered, true, 'OpenRouter hatası arayüzde gösterilmeli');
  assert.equal(first.errorPersisted, true, 'OpenRouter hatası sohbete kaydedilmeli');
  assert.equal(first.stopWasAvailable, true, 'yanıt akarken gönder düğmesi durdurma düğmesine dönüşmeli');
  assert.equal(first.stopRecovered, true, 'iptalden sonra gönder düğmesi normale dönmeli');
  assert.equal(first.abortDidNotBecomeError, true, 'kullanıcı iptali hata olarak kaydedilmemeli');
  assert.equal(first.assistantRendered, true, 'gerçek main/IPC akışından dönen yanıt ekranda görünmeli');
  assert.equal(first.chatHasUserMessage, true, 'gönderilen kullanıcı mesajı sohbete kaydedilmeli');
  assert.equal(first.chatHasAssistantMessage, true, 'model yanıtı sohbete kaydedilmeli');
  assert.ok(first.chatCount >= 2, 'yeni sohbet listede saklanmalı');

  await stopElectron(child, cdp);
  child = null;
  cdp = null;

  child = startElectron(electronPath, root, userData, temp, mockPath);
  page = await waitForPage(child, userData);
  cdp = connectCdp(page.webSocketDebuggerUrl);
  await cdp.call('Runtime.enable');
  const restored = await evaluate(cdp, `(async () => {
    const started = Date.now();
    while (!(window.api && document.readyState === 'complete' && document.querySelectorAll('#chat-list > *').length > 0) && Date.now() - started < 10000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const settings = await window.api.getSettings();
    const chats = await window.api.loadChats();
    const chat = chats.find((entry) => entry.messages?.some((message) => message.role === 'assistant' && message.content === 'Harness yanıtı'));
    return {
      hasApiKey: settings.hasApiKey,
      customPrompt: settings.customPrompt,
      chatCount: chats.length,
      restoredAssistant: !!chat,
      restoredUser: !!chat?.messages.some((message) => message.role === 'user' && String(message.content).includes('Harness gerçek gönderim')),
      chatListed: document.querySelectorAll('#chat-list > *').length > 0
    };
  })()`);
  assert.equal(restored.hasApiKey, true, 'şifreli API anahtarı uygulama yeniden açılınca bulunmalı');
  assert.equal(restored.customPrompt, 'electron-smoke-persisted-setting', 'ayarlar süreç yeniden başladıktan sonra korunmalı');
  assert.ok(restored.chatCount >= first.chatCount, 'sohbetler uygulama yeniden açılınca korunmalı');
  assert.equal(restored.restoredAssistant, true, 'asistan yanıtı kalıcı sohbet kaydından yüklenmeli');
  assert.equal(restored.restoredUser, true);
  assert.equal(restored.chatListed, true, 'yüklenen sohbetler arayüzde listelenmeli');
});
