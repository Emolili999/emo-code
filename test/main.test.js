const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('node:module');

function loadMainHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'emocode-main-'));
  const userData = path.join(root, 'user-data');
  const appData = path.join(root, 'app-data');
  const handlers = new Map();
  const appEvents = new Map();
  const sentEvents = [];
  const modelResponses = [];
  const completionCalls = [];
  let ready;
  let selectedFolder = '/';
  let clipboardText = '';

  class BrowserWindow {
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      this.webContents = {
        send: (channel, payload) => sentEvents.push({ channel, payload }),
        setWindowOpenHandler: () => {},
        on: () => {},
        getURL: () => 'file:///emocode/renderer/index.html'
      };
    }
    loadFile() {}
    isDestroyed() { return this.destroyed; }
    static getAllWindows() { return []; }
  }

  const electron = {
    app: {
      getPath: (name) => ({ userData, appData, home: root }[name] || root),
      whenReady: () => ({ then: (callback) => { ready = callback; } }),
      on: (name, callback) => appEvents.set(name, callback),
      quit: () => {}
    },
    BrowserWindow,
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: [selectedFolder] }),
      showMessageBox: async () => ({ response: 0 })
    },
    shell: { openExternal: () => {} },
    session: { defaultSession: { setPermissionRequestHandler: () => {} } },
    safeStorage: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'test-keychain',
      encryptString: (value) => Buffer.from(`test:${value}`),
      decryptString: (value) => Buffer.from(value).toString().replace(/^test:/, '')
    },
    clipboard: { writeText: (value) => { clipboardText = value; } }
  };

  const openrouter = {
    streamCompletion: async (options) => {
      completionCalls.push(options);
      return modelResponses.shift() || ({
      msg: { role: 'assistant', content: 'IPC test yanıtı' },
      usage: { prompt: 12, completion: 4, cost: 0.001 },
      aborted: false
      });
    },
    complete: async () => ({ text: 'özet', cost: 0, prompt: 0, completion: 0 })
  };

  const mainPath = require.resolve('../main');
  delete require.cache[mainPath];
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electron;
    if (request === './lib/openrouter' && parent?.filename === mainPath) return openrouter;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    require(mainPath);
  } finally {
    Module._load = originalLoad;
  }
  ready();

  return {
    root, userData, handlers, appEvents, sentEvents,
    completionCalls,
    selectFolder: (value) => { selectedFolder = value; },
    setModelResponses: (responses) => modelResponses.push(...responses),
    clipboardValue: () => clipboardText,
    close: () => {
      appEvents.get('before-quit')?.();
      delete require.cache[mainPath];
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

test('main IPC: settings are validated and the API key stays encrypted', async () => {
  const app = loadMainHarness();
  try {
    const initial = app.handlers.get('settings:get')();
    assert.equal(initial.permissionMode, 'normal');
    assert.equal(initial.hasApiKey, false);

    const result = app.handlers.get('settings:set')(null, {
      apiKey: 'sk-or-test',
      maxSteps: '500',
      temperature: '2.5',
      permissionMode: 'invalid',
      theme: 'invalid',
      customPrompt: '  Türkçe yanıt ver  '
    });

    assert.equal(result.hasApiKey, true);
    assert.equal(result.maxSteps, 100);
    assert.equal(result.temperature, undefined);
    assert.equal(result.permissionMode, 'normal');
    assert.equal(result.theme, undefined);
    assert.equal(result.customPrompt, 'Türkçe yanıt ver');
    assert.equal(Object.hasOwn(result, 'apiKey'), false);

    const saved = JSON.parse(fs.readFileSync(path.join(app.userData, 'settings.json'), 'utf8'));
    assert.equal(saved.apiKey, undefined);
    assert.equal(Buffer.from(saved.apiKeyEnc, 'base64').toString(), 'test:sk-or-test');
  } finally {
    app.close();
  }
});
test('main IPC: sohbet kaydı ekleri dışarı taşır, geri okur ve modele çözer', async () => {
  const app = loadMainHarness();
  try {
    app.handlers.get('settings:set')(null, { apiKey: 'sk-or-test' });
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    const pdfData = 'data:application/pdf;base64,JVBERi0xLjQK';
    assert.equal(app.handlers.get('chats:save')(null, [{
      id: 'with-image', messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: dataUrl } },
        { type: 'file', file: { filename: 'report.pdf', file_data: pdfData } }
      ] }]
    }]), true);

    const storedContent = app.handlers.get('chats:load')()[0].messages[0].content;
    const stored = storedContent[0];
    const storedPdf = storedContent[1];
    assert.equal(stored.type, 'image_ref');
    assert.match(stored.ref, /^att-[a-f0-9]{32}$/);
    assert.equal(app.handlers.get('attachment:get')(null, stored.ref), dataUrl);
    assert.equal(storedPdf.type, 'file_ref');
    assert.equal(storedPdf.filename, 'report.pdf');

    app.setModelResponses([{ msg: { role: 'assistant', content: 'Görsel alındı.' }, usage: null, aborted: false }]);
    await app.handlers.get('chat:send')(null, {
      chatId: 'with-image', messages: [{ role: 'user', content: [{ type: 'text', text: 'Bak' }, stored, storedPdf] }],
      model: 'test/model', noTools: true
    });
    const apiMessage = app.completionCalls[0].messages.find((message) => message.role === 'user');
    assert.equal(apiMessage.content[0].text, 'Bak');
    assert.deepEqual(apiMessage.content[1], { type: 'image_url', image_url: { url: dataUrl } });
    assert.deepEqual(apiMessage.content[2], { type: 'file', file: { filename: 'report.pdf', file_data: pdfData } });
  } finally {
    app.close();
  }
});

test('main IPC: yazma aracı onay bekler, IPC yanıtından sonra tamamlanır', async () => {
  const app = loadMainHarness();
  try {
    app.handlers.get('settings:set')(null, { apiKey: 'sk-or-test' });
    const workspace = path.join(app.root, 'project');
    fs.mkdirSync(workspace);
    app.setModelResponses([
      {
        msg: { role: 'assistant', content: '', tool_calls: [{
          id: 'write-1', type: 'function', function: { name: 'write_file', arguments: '{"path":"new.txt","content":"yeni içerik"}' }
        }] },
        usage: { prompt: 10, completion: 5, cost: 0.001 }, aborted: false
      },
      { msg: { role: 'assistant', content: 'Dosyayı oluşturdum.' }, usage: null, aborted: false }
    ]);

    const pending = app.handlers.get('chat:send')(null, {
      chatId: 'approval-chat', messages: [{ role: 'user', content: 'Dosya oluştur' }],
      model: 'test/model', workspace
    });
    const deadline = Date.now() + 3000;
    let approval;
    while (Date.now() < deadline && !approval) {
      approval = app.sentEvents.find((event) => event.payload.type === 'approval')?.payload;
      if (!approval) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(approval, 'main süreci onay IPC olayı göndermeli');
    assert.equal(approval.title, 'Yeni dosya: new.txt');
    assert.equal(fs.existsSync(path.join(workspace, 'new.txt')), false);

    assert.equal(app.handlers.get('approval:respond')(null, approval.id, 'allow'), true);
    await pending;
    assert.equal(fs.readFileSync(path.join(workspace, 'new.txt'), 'utf8'), 'yeni içerik');
    assert.ok(app.sentEvents.some((event) => event.payload.type === 'tool_result' && /Yazıldı/.test(event.payload.result)));
    assert.ok(app.sentEvents.some((event) => event.payload.type === 'done'));
  } finally {
    app.close();
  }
});

test('main IPC: chat send emits a complete event and rejects workspaces outside the allowed scope', async () => {
  const app = loadMainHarness();
  try {
    const send = app.handlers.get('chat:send');
    const request = {
      chatId: 'ipc-chat', messages: [{ role: 'user', content: 'Merhaba' }],
      model: 'test/model', noTools: true
    };

    await send(null, request);
    assert.match(app.sentEvents.at(-1).payload.error, /API anahtarı/);

    app.handlers.get('settings:set')(null, { apiKey: 'sk-or-test' });
    const workspace = path.join(app.root, 'project');
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, 'answer.txt'), 'dosya içeriği');
    app.setModelResponses([
      {
        msg: {
          role: 'assistant', content: '',
          tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"answer.txt"}' } }]
        },
        usage: { prompt: 20, completion: 4, cost: 0.002 }, aborted: false
      },
      { msg: { role: 'assistant', content: 'Dosyayı okudum.' }, usage: null, aborted: false }
    ]);
    app.sentEvents.length = 0;
    await send(null, { ...request, noTools: false, workspace });
    assert.ok(app.sentEvents.some((event) => event.payload.type === 'usage'));
    assert.ok(app.sentEvents.some((event) => event.payload.type === 'tool_start' && event.payload.name === 'read_file'));
    assert.ok(app.sentEvents.some((event) => event.payload.type === 'tool_result' && /dosya içeriği/.test(event.payload.result)));
    const done = app.sentEvents.find((event) => event.payload.type === 'done');
    assert.ok(done);
    assert.equal(done.payload.messages.at(-1).content, 'Dosyayı okudum.');

    app.selectFolder('/');
    assert.equal(await app.handlers.get('workspace:pick')(), null);
  } finally {
    app.close();
  }
});

test('main IPC: sohbet depolama, pano, API anahtarı doğrulama ve model filtreleme', async () => {
  const app = loadMainHarness();
  const originalFetch = global.fetch;
  try {
    assert.deepEqual(app.handlers.get('chats:load')(), []);
    assert.equal(app.handlers.get('chats:save')(null, {}), false);
    assert.equal(app.handlers.get('chats:save')(null, [{ id: 'one', title: 'Test' }]), true);
    assert.deepEqual(app.handlers.get('chats:load')(), [{ id: 'one', title: 'Test' }]);

    app.handlers.get('clipboard:write')(null, 123);
    assert.equal(app.clipboardValue(), '123');
    app.handlers.get('settings:set')(null, { apiKey: 'sk-or-test' });

    global.fetch = async (url, options) => {
      if (String(url).endsWith('/auth/key')) {
        assert.equal(options.headers.Authorization, 'Bearer sk-or-custom');
        return { ok: true, json: async () => ({ data: { label: 'test-key' } }) };
      }
      assert.match(String(url), /\/models$/);
      assert.equal(options.headers.Authorization, 'Bearer sk-or-test');
      return {
        ok: true,
        json: async () => ({ data: [
          { id: 'z/model', name: 'Z', architecture: { input_modalities: ['text'], output_modalities: ['text'] }, context_length: 1234 },
          { id: 'image/model', architecture: { input_modalities: ['image'], output_modalities: ['image'] } },
          { id: 'a/model:free', architecture: { input_modalities: ['text'], output_modalities: ['text'] }, pricing: { prompt: '0', completion: '0' } }
        ] })
      };
    };

    assert.deepEqual(await app.handlers.get('auth:check_key')(null, 'sk-or-custom'), { ok: true, data: { label: 'test-key' } });
    const models = await app.handlers.get('models:list')();
    assert.deepEqual(models.map((model) => model.id), ['a/model:free', 'z/model']);
    assert.equal(models[0].free, true);
    assert.equal(models[1].context, 1234);
  } finally {
    global.fetch = originalFetch;
    app.close();
  }
});
