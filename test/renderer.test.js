const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer/index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer/renderer.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

test('renderer DOM sözleşmesi: zorunlu seçiciler ve API çağrıları HTML/bridge içinde var', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'HTML içinde yinelenen id var');

  // Bunlar eski arayüz varyantlarında bulunabiliyor; renderer bunları opsiyonel kullanıyor.
  const optionalIds = new Set(['web-toggle', 'reasoning-toggle']);
  const referencedIds = new Set([...renderer.matchAll(/\$\(['"]([^'"]+)['"]\)/g)].map((match) => match[1]));
  const missingIds = [...referencedIds].filter((id) => !ids.includes(id) && !optionalIds.has(id));
  assert.deepEqual(missingIds, []);

  const bridgeMethods = new Set([...preload.matchAll(/^\s{2}([A-Za-z_$][\w$]*):\s*\(/gm)].map((match) => match[1]));
  const usedMethods = new Set([...renderer.matchAll(/window\.api\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]));
  assert.deepEqual([...usedMethods].filter((name) => !bridgeMethods.has(name)), []);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /<script src="renderer\.js"><\/script>/);
});

test('preload: renderer yalnızca açıkça tanımlanmış IPC API yüzeyini alır', () => {
  const calls = [];
  const listeners = [];
  let exposed;
  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => { assert.equal(name, 'api'); exposed = api; } },
    ipcRenderer: {
      invoke: (...args) => { calls.push(args); return Promise.resolve('ok'); },
      on: (...args) => { listeners.push(args); }
    }
  };
  const preloadPath = require.resolve('../preload');
  delete require.cache[preloadPath];
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron' && parent?.filename === preloadPath) return electron;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[preloadPath];
  }

  const expected = [
    'getSettings', 'setSettings', 'checkApiKey', 'sysInfo', 'loadChats', 'saveChats', 'pickFolder',
    'listModels', 'send', 'stop', 'compact', 'updateMd', 'forget', 'exportChat', 'checkpointSummary',
    'checkpointDetails', 'checkpointRunDetails', 'undo', 'undoRun', 'undoAll', 'undoFile', 'approve',
    'answer', 'getAttachment', 'copy', 'onEvent', 'markdown'
  ];
  assert.deepEqual(Object.keys(exposed).sort(), expected.sort());
  assert.equal(Object.hasOwn(exposed, 'invoke'), false);
  exposed.setSettings({ maxSteps: 8 });
  assert.deepEqual(calls[0], ['settings:set', { maxSteps: 8 }]);
  exposed.onEvent(() => {});
  assert.equal(listeners[0][0], 'chat:event');
  assert.match(exposed.markdown('<img src=x onerror=alert(1)>'), /&lt;img/);
});
