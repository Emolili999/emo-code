const { contextBridge, ipcRenderer } = require('electron');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let renderMarkdown = (text) => `<pre>${esc(text)}</pre>`;
try {
  // Sandbox kapalı test/geliştirme ortamlarında yedek olarak çalışır; sandbox: true iken renderer kendi kopyasını kullanır.
  const { marked } = require('marked');
  const createDOMPurify = require('dompurify');
  const DOMPurify = typeof createDOMPurify === 'function' ? createDOMPurify(window) : createDOMPurify;

  const renderer = new marked.Renderer();
  renderer.html = (h) => esc(typeof h === 'string' ? h : h.text || '');
  marked.setOptions({ renderer, gfm: true, breaks: true });

  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'IMG') {
      const src = node.getAttribute('src') || '';
      if (!/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(src)) {
        const alt = node.getAttribute('alt') || '';
        const span = node.ownerDocument.createElement('span');
        span.className = 'blocked-img';
        span.textContent = `[görsel engellendi${alt ? ': ' + alt : ''}]`;
        span.title = 'Güvenlik nedeniyle uzak görseller yüklenmez.';
        node.replaceWith(span);
      }
    } else if (node.tagName === 'A') {
      const href = node.getAttribute('href') || '';
      if (!/^(https?:|mailto:|#)/i.test(href)) node.removeAttribute('href');
      node.setAttribute('rel', 'noopener noreferrer');
      node.setAttribute('title', href);
    }
  });

  const SANITIZE = {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'svg', 'math'],
    FORBID_ATTR: ['style', 'srcset', 'target'],
    ALLOW_DATA_ATTR: false
  };
  renderMarkdown = (text) => DOMPurify.sanitize(marked.parse(String(text ?? '')), SANITIZE);
} catch { /* sandbox: true modunda marked/dompurify renderer içinde yüklenir */ }

const invoke = (ch, ...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('api', {
  getSettings: () => invoke('settings:get'),
  setSettings: (patch) => invoke('settings:set', patch),
  checkApiKey: (key) => invoke('auth:check_key', key),
  sysInfo: () => invoke('sys:info'),
  loadChats: () => invoke('chats:load'),
  saveChats: (c) => invoke('chats:save', c),
  pickFolder: () => invoke('workspace:pick'),
  listModels: () => invoke('models:list'),
  send: (payload) => invoke('chat:send', payload),
  stop: (chatId) => invoke('chat:stop', chatId),
  compact: (payload) => invoke('chat:compact', payload),
  updateMd: (payload) => invoke('chat:update_md', payload),
  forget: (chatId) => invoke('chat:forget', chatId),
  exportChat: (payload) => invoke('chat:export', payload),
  checkpointSummary: (chatId) => invoke('checkpoint:summary', chatId),
  checkpointDetails: (chatId) => invoke('checkpoint:details', chatId),
  undo: (chatId) => invoke('checkpoint:undo', chatId),
  undoAll: (chatId) => invoke('checkpoint:undo_all', chatId),
  undoFile: (chatId, filePath) => invoke('checkpoint:undo_file', { chatId, filePath }),
  approve: (id, decision) => invoke('approval:respond', id, decision),
  answer: (id, text) => invoke('question:respond', id, text),
  copy: (text) => invoke('clipboard:write', String(text ?? '')),
  onEvent: (cb) => ipcRenderer.on('chat:event', (_, e) => cb(e)),
  markdown: (text) => renderMarkdown(text)
});
