const $ = (id) => document.getElementById(id);

const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.5';
const DEFAULT_SUBAGENT_MODEL = 'google/gemini-2.5-flash';
const NEW_TITLE = 'Yeni sohbet';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 200 * 1024;
const MAX_ATTACHMENTS = 6;

const SUBAGENT_PRESETS = [
  { id: 'google/gemini-2.5-flash', icon: '⚡', name: 'Gemini 2.5 Flash (Önerilen F/P)', desc: 'Çok hızlı, 1M bağlam, çok düşük maliyet' },
  { id: 'deepseek/deepseek-chat', icon: '🧠', name: 'DeepSeek V3', desc: 'Ekonomik ve güçlü kod analizi' },
  { id: 'openai/gpt-4.1-mini', icon: '🚀', name: 'GPT-4.1 Mini', desc: 'Hızlı ve kararlı araç çağırma' },
  { id: 'anthropic/claude-3.5-haiku', icon: '🎯', name: 'Claude 3.5 Haiku', desc: 'Hızlı ve odaklı Claude modeli' },
  { id: 'same', icon: '🔄', name: 'Ana Model ile Aynı', desc: 'Sohbette seçili olan ana modeli kullanır' }
];

const TOOL_TITLES = {
  list_dir: 'LS',
  read_file: 'Read',
  glob: 'Glob',
  search_files: 'Grep',
  write_file: 'Write',
  edit_file: 'Edit',
  multi_edit: 'MultiEdit',
  run_command: 'Bash',
  web_fetch: 'WebFetch',
  web_search: 'Web Search',
  shell_session: 'Shell Session',
  background_process: 'Arka Plan Süreci',
  git: 'Git',
  todo_write: 'TodoWrite',
  ask_user: 'AskUser',
  subagent_explore: 'Subagent'
};

let settings = {};
let sysInfo = {};
let chats = [];
let activeId = null;
let renamingId = null;
let search = '';
let slashIndex = 0;
let attachments = [];            // { kind: 'image'|'text', name, data|text }
let allModels = [];              // OpenRouter'dan gelen güncel model listesi
let modelFilterFamily = 'all';   // all | claude | gemini | gpt | deepseek | qwen | llama | grok | mistral | other
const modelFilterCaps = new Set(); // tools | images | free
let modelSearchQuery = '';
let modelFocusIdx = -1;
const modelInfo = new Map();     // id -> { tools, images, context }
const running = new Set();       // çalışan sohbet kimlikleri
const live = {};                 // chatId -> { el, textEl, text, tools, raf, reasoningEl, reasoning, status }

const PERM_MODES = {
  strict: { label: 'Sıkı', class: 'mode-strict', desc: 'Her komudu tek tek sor' },
  normal: { label: 'Normal', class: 'mode-normal', desc: 'Riskli kodlarda uyarı ver' },
  auto: { label: 'Oto', class: 'mode-auto', desc: 'Kendin karar ver (akıllı onay)' },
  turbo: { label: 'Turbo', class: 'mode-turbo', desc: 'Tüm kodlara izin ver (tam otomatik)' }
};
let currentPermissionMode = 'normal';

function setPermissionMode(mode, save = true) {
  if (!PERM_MODES[mode]) mode = 'normal';
  currentPermissionMode = mode;

  const btn = $('perm-btn');
  const label = $('perm-label');

  if (label) label.textContent = PERM_MODES[mode].label;

  if (btn) {
    btn.classList.remove('mode-strict', 'mode-normal', 'mode-auto', 'mode-turbo');
    btn.classList.add(PERM_MODES[mode].class);
    btn.title = `İzin Modu (${PERM_MODES[mode].label}): ${PERM_MODES[mode].desc}`;
  }

  // Menüdeki aktif seçeneği güncelle
  document.querySelectorAll('#perm-menu .perm-option').forEach((opt) => {
    opt.classList.toggle('active', opt.dataset.mode === mode);
  });

  // Modal içindeki radyo butonları güncelle
  const radios = document.getElementsByName('perm-mode');
  for (const r of radios) {
    r.checked = (r.value === mode);
  }
  document.querySelectorAll('.perm-radio-card').forEach((card) => {
    card.classList.toggle('active', card.dataset.mode === mode);
  });

  if (save) {
    settings.permissionMode = mode;
    settings.autoApprove = mode === 'auto' || mode === 'turbo';
    window.api.setSettings({ permissionMode: mode, autoApprove: settings.autoApprove });
  }
}

const messagesEl = $('messages');
const inputEl = $('input');
const sendBtn = $('send');
const modelInput = $('model-input');
const emptyEl = $('empty');

// ------------------------------------------------------------------ yardımcılar
const active = () => chats.find((c) => c.id === activeId);
const saveChats = () => window.api.saveChats(chats);
const baseName = (p) => (p ? p.split(/[\\/]/).filter(Boolean).pop() || p : '');
const textOf = (content) => (Array.isArray(content)
  ? content.map((p) => (p.type === 'text' ? p.text : '[görsel]')).join('\n')
  : String(content ?? ''));
const fmtCost = (n) => (n >= 0.1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`);
const fmtTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

const isChatSubagentOn = (chat) => (chat && typeof chat.subagentEnabled === 'boolean'
  ? chat.subagentEnabled
  : settings.subagentEnabled !== false);
const getActiveSubagentModel = () => (settings.subagentModel || DEFAULT_SUBAGENT_MODEL);
const shortSubagentLabel = (modelId) => {
  const m = String(modelId || DEFAULT_SUBAGENT_MODEL).trim();
  if (!m || m === 'same') return 'Ana Model';
  return m.split('/').pop() || m;
};

function newChat() {
  const chat = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    title: NEW_TITLE,
    model: settings.defaultModel || DEFAULT_MODEL,
    workspace: settings.lastWorkspace || null,
    subagentEnabled: settings.subagentEnabled !== false,
    messages: [],
    createdAt: Date.now(),
    cost: 0,
    lastPrompt: 0,
    stepsSinceMd: 0,
    totalSteps: 0
  };
  chats.unshift(chat);
  activeId = chat.id;
  saveChats();
  renderAll();
  inputEl.focus();
}

function isNearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
}
function scrollDown() { messagesEl.scrollTop = messagesEl.scrollHeight; }

function addRow(parent, className) {
  const row = document.createElement('div');
  row.className = 'row';
  const inner = document.createElement('div');
  if (className) inner.className = className;
  row.appendChild(inner);
  parent.appendChild(row);
  return inner;
}

function toolLabel(args) {
  if (!args) return '';
  const v = args.task ?? args.path ?? args.command ?? args.pattern ?? args.query ?? args.url ?? args.question ?? args.id ?? args.action ?? '';
  return String(v).length > 80 ? String(v).slice(0, 80) + '…' : String(v);
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const SANITIZE_CFG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'svg', 'math'],
  FORBID_ATTR: ['style', 'srcset', 'target'],
  ALLOW_DATA_ATTR: false
};
if (window.marked && window.DOMPurify) {
  const mdRenderer = new window.marked.Renderer();
  mdRenderer.html = (h) => escHtml(typeof h === 'string' ? h : h.text || '');
  window.marked.setOptions({ renderer: mdRenderer, gfm: true, breaks: true });
  window.DOMPurify.addHook('afterSanitizeAttributes', (node) => {
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
}
function safeMarkdown(text) {
  if (window.marked && window.DOMPurify) {
    return window.DOMPurify.sanitize(window.marked.parse(String(text ?? '')), SANITIZE_CFG);
  }
  return window.api.markdown(text);
}

// Markdown çıktısı (DOMPurify ile temizlenmiş) + kod bloklarına "Kopyala" düğmesi (olay delegasyonu ile)
function setMarkdown(target, text, { streaming = false } = {}) {
  if (streaming) {
    const sel = window.getSelection?.();
    if (sel && !sel.isCollapsed && target.contains(sel.anchorNode)) return;
  }
  const scrollLefts = [...target.querySelectorAll('pre')].map((p) => p.scrollLeft);
  target.innerHTML = safeMarkdown(text);
  target.querySelectorAll('pre').forEach((pre, idx) => {
    if (scrollLefts[idx]) pre.scrollLeft = scrollLefts[idx];
    const btn = el('button', 'copy-btn', 'Kopyala');
    btn.type = 'button';
    pre.appendChild(btn);
  });
}

messagesEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.copy-btn');
  if (!btn) return;
  const pre = btn.closest('pre');
  if (!pre) return;
  const code = pre.querySelector('code')?.textContent ?? pre.textContent.replace(/Kopyala$/, '');
  window.api.copy(code);
  btn.textContent = 'Kopyalandı';
  setTimeout(() => { if (btn.isConnected) btn.textContent = 'Kopyala'; }, 1200);
});

function renderTodos(todos) {
  const ul = el('ul', 'todos');
  for (const t of Array.isArray(todos) ? todos : []) {
    const li = el('li', t?.status || 'pending');
    li.textContent = `${t?.status === 'completed' ? '☑' : t?.status === 'in_progress' ? '▶' : '☐'} ${t?.content ?? ''}`;
    ul.appendChild(li);
  }
  return ul;
}

function makeToolEl(name, args, result) {
  const d = document.createElement('details');
  d.className = 'tool' + (result === undefined ? ' pending' : '');
  const s = document.createElement('summary');
  const displayTitle = TOOL_TITLES[name] || name;
  const labelText = name === 'todo_write' ? 'görev listesi' : toolLabel(args);
  s.append(el('span', 'name', displayTitle), el('span', 'arg-summary', labelText));
  d.appendChild(s);

  if (name === 'todo_write' && args?.todos) {
    d.open = true;
    d.appendChild(renderTodos(args.todos));
  } else {
    const argPre = el('pre', null, args ? JSON.stringify(args, null, 2) : '(argümanlar okunamadı)');
    d.appendChild(argPre);
  }

  let livePre = null;
  const appendOutput = (text) => {
    if (!livePre) { livePre = el('pre', 'live'); d.appendChild(livePre); }
    livePre.textContent = (livePre.textContent + text).slice(-20000);
    livePre.scrollTop = livePre.scrollHeight;
  };
  const setResult = (text, atts) => {
    d.classList.remove('pending');
    livePre?.remove();
    if (name === 'todo_write') return;
    d.appendChild(el('pre', null, text));
    for (const url of atts || []) if (/^data:image\//.test(url)) d.appendChild(makeAttImg(url));
  };
  if (result !== undefined) setResult(result);
  return { el: d, setResult, appendOutput };
}

function makeReasoningEl() {
  const d = el('details', 'reasoning');
  d.appendChild(el('summary', null, 'Düşünce süreci'));
  d.appendChild(el('pre'));
  return d;
}

// image_ref → data URL (main süreçte attachments deposundan okunur); aynı ref tekrar okunmaz.
const attachmentCache = new Map();
function loadAttachment(ref) {
  if (!attachmentCache.has(ref)) attachmentCache.set(ref, window.api.getAttachment(ref).catch(() => null));
  return attachmentCache.get(ref);
}
function makeAttImg(url) {
  const img = document.createElement('img');
  img.src = url;
  img.className = 'att-img';
  img.alt = 'ek görsel';
  return img;
}

function renderUserContent(target, content) {
  if (!Array.isArray(content)) { target.textContent = content; return; }
  for (const p of content) {
    if (p.type === 'text') target.appendChild(el('div', null, p.text));
    else if (p.type === 'image_ref') {
      const holder = el('span', 'blocked-img', '[görsel yükleniyor…]');
      target.appendChild(holder);
      loadAttachment(p.ref).then((url) => {
        if (url && /^data:image\//.test(url)) holder.replaceWith(makeAttImg(url));
        else holder.textContent = '[görsel bulunamadı]';
      });
    }
    else if (p.type === 'file_ref') target.appendChild(el('span', 'file-attachment', `📄 ${p.filename || 'PDF eki'}`));
    else if (p.type === 'image_url' && /^data:image\//.test(p.image_url?.url || '')) {
      const img = document.createElement('img');
      img.src = p.image_url.url;
      img.className = 'att-img';
      img.alt = 'ek görsel';
      target.appendChild(img);
    }
  }
}

// ------------------------------------------------------------------ çizim
function chatMatches(chat, q) {
  if (!q) return true;
  if (chat.title.toLowerCase().includes(q)) return true;
  return chat.messages.some((m) => (m.role === 'user' || m.role === 'assistant') && textOf(m.content).toLowerCase().includes(q));
}

function renderSidebar() {
  const list = $('chat-list');
  list.replaceChildren();
  const q = search.trim().toLowerCase();
  const shown = chats.filter((c) => chatMatches(c, q));
  if (!shown.length) list.appendChild(el('div', 'hint pad', q ? 'Eşleşen oturum yok.' : ''));
  for (const chat of shown) {
    const item = el('div', 'chat-item' + (chat.id === activeId ? ' active' : ''));
    if (renamingId === chat.id) {
      const inp = el('input', 'rename-input');
      inp.type = 'text';
      inp.value = chat.title;
      inp.maxLength = 100;
      let committed = false;
      const commit = (save) => {
        if (committed) return;
        committed = true;
        if (save && inp.value.trim()) {
          chat.title = inp.value.trim().slice(0, 100);
          saveChats();
        }
        renamingId = null;
        renderSidebar();
      };
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(true); }
        else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
      });
      inp.addEventListener('blur', () => commit(true));
      inp.addEventListener('click', (e) => e.stopPropagation());
      item.appendChild(inp);
      list.appendChild(item);
      requestAnimationFrame(() => { inp.focus(); inp.select(); });
      continue;
    }

    const title = el('span', 'title', chat.title);
    title.title = chat.workspace ? `${chat.title}\n${chat.workspace}` : chat.title;
    if (running.has(chat.id)) title.prepend('⟳ ');
    title.addEventListener('dblclick', (e) => { e.stopPropagation(); startRename(chat); });

    const ren = el('button', 'del', '✎');
    ren.title = 'Yeniden adlandır';
    ren.addEventListener('click', (e) => { e.stopPropagation(); startRename(chat); });
    const del = el('button', 'del danger', '✕');
    del.title = 'Oturumu sil';
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteChat(chat.id); });
    item.append(title, ren, del);
    item.addEventListener('click', () => { activeId = chat.id; renderAll(); });
    list.appendChild(item);
  }
}

function startRename(chat) {
  renamingId = chat.id;
  renderSidebar();
}

const REASONING_LABELS = {
  '': 'Varsayılan',
  none: 'Kapalı',
  low: 'Düşük',
  medium: 'Orta',
  high: 'Yüksek'
};
const REASONING_ORDER = ['', 'low', 'medium', 'high', 'none'];

function renderRuntimeOptions() {
  const webOn = !!settings.webSearch;
  const effort = settings.reasoningEffort || '';
  const optWeb = $('opt-web');
  if (optWeb) {
    optWeb.classList.toggle('active', webOn);
    optWeb.setAttribute('aria-pressed', String(webOn));
  }
  const webToggle = $('web-toggle');
  if (webToggle) {
    webToggle.classList.toggle('on', webOn);
    webToggle.setAttribute('aria-pressed', String(webOn));
  }
  document.querySelectorAll('#model-runtime-bar .reasoning-chip').forEach((btn) => {
    const activeEffort = (btn.dataset.effort || '') === effort;
    btn.classList.toggle('active', activeEffort);
    btn.setAttribute('aria-pressed', String(activeEffort));
  });
  const rToggle = $('reasoning-toggle');
  if (rToggle) {
    rToggle.textContent = `🧠 Düşünme: ${REASONING_LABELS[effort] || 'Varsayılan'}`;
    rToggle.classList.toggle('on', effort !== '' && effort !== 'none');
  }
}

function renderTopbar() {
  const chat = active();
  modelInput.value = (chat?.model || '').replace(/:online$/i, '');
  const btn = $('pick-folder');
  btn.textContent = chat?.workspace ? `📁 ${baseName(chat.workspace)}` : '📁 Klasör seç';
  btn.title = chat?.workspace || 'Çalışma klasörünü seç';
  $('plan-toggle').classList.toggle('on', !!chat?.planMode);

  const subOn = isChatSubagentOn(chat);
  const subToggle = $('subagent-toggle');
  const subLabel = $('subagent-status-label');
  const subModel = getActiveSubagentModel();
  if (subToggle) {
    subToggle.classList.toggle('on', subOn);
    subToggle.setAttribute('aria-pressed', String(subOn));
    subToggle.title = subOn
      ? `Bu sohbette Alt Ajan (Subagent) AÇIK · Model: ${subModel === 'same' ? 'Ana Model ile Aynı' : subModel} (Kapatmak için tıkla)`
      : 'Bu sohbette Alt Ajan (Subagent) KAPALI (Açmak için tıkla)';
  }
  if (subLabel) {
    subLabel.textContent = subOn ? `Subagent: Açık (${shortSubagentLabel(subModel)})` : 'Subagent: Kapalı';
  }
  renderRuntimeOptions();

  const metaWs = $('meta-workspace');
  if (metaWs) {
    const wsText = chat?.workspace ? `cwd: ${chat.workspace}` : 'Çalışma klasörü seçilmedi ("Klasör seç" ile belirle)';
    metaWs.textContent = chat?.planMode ? `[PLAN MODU] · ${wsText}` : wsText;
  }
  const welcomeWs = $('welcome-ws');
  if (welcomeWs) {
    welcomeWs.textContent = chat?.workspace
      ? `Çalışma klasörü: ${chat.workspace}`
      : 'Henüz çalışma klasörü seçilmedi — sağ üstten "Klasör seç" düğmesine tıkla.';
  }

  updateUsage();
  updateUndo();
}

function updateUsage() {
  const chat = active();
  const u = $('usage');
  const parts = [];
  if (chat?.cost > 0) parts.push(fmtCost(chat.cost));
  if (chat?.lastPrompt > 0) parts.push(`${fmtTokens(chat.lastPrompt)} bağlam`);
  if (settings.mdUpdateSteps > 0 && chat?.workspace) {
    parts.push(`📝 ${chat?.stepsSinceMd || 0}/${settings.mdUpdateSteps} adım`);
  }
  u.hidden = !parts.length;
  u.textContent = parts.join(' · ');
  u.title = settings.mdUpdateSteps > 0
    ? `Bu sohbetin toplam maliyeti, son bağlam boyutu ve EMO.md otomatik güncelleme sayacı (her ${settings.mdUpdateSteps} adımda bir)`
    : 'Bu sohbetin toplam maliyeti ve son istekteki bağlam boyutu';
  if (settings.budget > 0 && chat?.cost >= settings.budget) u.classList.add('over'); else u.classList.remove('over');
}

let currentChangesDetails = null;
let selectedChangesFile = null;
let showFullChangesDiff = false;
let selectedChangesRunId = null;

async function updateUndo() {
  const chat = active();
  const undoBtn = $('undo-btn');
  const changesBtn = $('changes-btn');
  if (!chat || running.has(chat.id)) {
    if (undoBtn) undoBtn.hidden = true;
    if (changesBtn) changesBtn.hidden = true;
    return;
  }
  const id = chat.id;
  try {
    const s = await window.api.checkpointSummary(id);
    if (activeId === id) {
      const hasChanges = !!(s && s.files);
      if (undoBtn) {
        undoBtn.hidden = !hasChanges;
        undoBtn.dataset.files = String(s.files || 0);
        undoBtn.title = hasChanges ? `Son çalışmada değişen ${s.files} dosyayı geri al` : '';
      }
      if (changesBtn) {
        if (hasChanges) {
          const det = await window.api.checkpointDetails(id);
          currentChangesDetails = det;
          const hasDiffFiles = !!(det && det.totalFiles > 0);
          changesBtn.hidden = !hasDiffFiles;
          const badge = $('changes-badge');
          if (badge && hasDiffFiles) {
            badge.textContent = `${det.totalFiles} dosya (+${det.totalAdditions} -${det.totalDeletions})`;
          }
        } else {
          changesBtn.hidden = true;
        }
      }
    }
  } catch {
    if (undoBtn) undoBtn.hidden = true;
    if (changesBtn) changesBtn.hidden = true;
  }
}

function closeChangesModal() {
  $('changes-modal')?.classList.add('hidden');
}

async function openChangesModal(targetPath = null, runId = null) {
  const chat = active();
  if (!chat) return;
  const modal = $('changes-modal');
  if (!modal) return;

  try {
    selectedChangesRunId = runId;
    currentChangesDetails = runId
      ? await window.api.checkpointRunDetails(chat.id, runId)
      : await window.api.checkpointDetails(chat.id);
  } catch (e) {
    notice(chat, `Değişiklikler yüklenemedi: ${e.message}`);
    return;
  }

  const det = currentChangesDetails;
  $('changes-modal-title').textContent = runId ? 'Bu Çalışmanın Değişiklikleri' : 'Değişiklik İnceleme (Diff & Review)';
  $('changes-undo-all').hidden = !!runId;
  $('changes-count-files').textContent = `${det.totalFiles} dosya`;
  $('changes-count-adds').textContent = `+${det.totalAdditions} satır eklendi`;
  $('changes-count-dels').textContent = `-${det.totalDeletions} satır silindi`;

  if (targetPath) {
    selectedChangesFile = det.files.find((f) => f.path === targetPath) || det.files[0] || null;
  } else if (!selectedChangesFile || !det.files.some((f) => f.path === selectedChangesFile.path)) {
    selectedChangesFile = det.files[0] || null;
  }

  renderChangesFileList();
  renderChangesDiffPanel();
  modal.classList.remove('hidden');
}

function renderChangesFileList() {
  const listEl = $('changes-file-list');
  if (!listEl) return;
  listEl.replaceChildren();

  const files = currentChangesDetails?.files || [];
  if (!files.length) {
    const empty = document.createElement('div');
    empty.className = 'changes-diff-empty';
    empty.textContent = 'Bu oturumda kaydedilmiş değişiklik yok.';
    listEl.appendChild(empty);
    return;
  }

  for (const f of files) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'changes-file-item' + (selectedChangesFile?.path === f.path ? ' active' : '');
    btn.title = f.relativePath;

    const left = document.createElement('div');
    left.className = 'cf-left';

    const badge = document.createElement('span');
    badge.className = `cf-status-badge status-${f.status}`;
    const statusLabels = { created: 'YENİ', modified: 'MOD', deleted: 'SİL', binary: 'BİN' };
    badge.textContent = statusLabels[f.status] || 'MOD';

    const pathSpan = document.createElement('span');
    pathSpan.className = 'cf-path';
    pathSpan.textContent = f.relativePath;

    left.append(badge, pathSpan);

    const stats = document.createElement('div');
    stats.className = 'cf-stats';
    if (f.additions > 0) {
      const add = document.createElement('span');
      add.className = 'cf-add';
      add.textContent = `+${f.additions}`;
      stats.appendChild(add);
    }
    if (f.deletions > 0) {
      const del = document.createElement('span');
      del.className = 'cf-del';
      del.textContent = `-${f.deletions}`;
      stats.appendChild(del);
    }

    btn.append(left, stats);
    btn.addEventListener('click', () => {
      selectedChangesFile = f;
      renderChangesFileList();
      renderChangesDiffPanel();
    });
    listEl.appendChild(btn);
  }
}

function renderChangesDiffPanel() {
  const panel = $('changes-diff-panel');
  if (!panel) return;
  panel.replaceChildren();

  const f = selectedChangesFile;
  if (!f) {
    const empty = document.createElement('div');
    empty.className = 'changes-diff-empty';
    empty.textContent = 'İncelemek için soldan bir dosya seçin.';
    panel.appendChild(empty);
    return;
  }

  // Panel Başlığı
  const head = document.createElement('div');
  head.className = 'diff-panel-head';

  const titleWrap = document.createElement('div');
  titleWrap.className = 'diff-panel-title';

  const statusBadge = document.createElement('span');
  statusBadge.className = `cf-status-badge status-${f.status}`;
  const statusFull = { created: 'Oluşturuldu', modified: 'Düzenlendi', deleted: 'Silindi', binary: 'İkili dosya' };
  statusBadge.textContent = statusFull[f.status] || 'Düzenlendi';

  const pathSpan = document.createElement('span');
  pathSpan.className = 'diff-file-path';
  pathSpan.textContent = f.relativePath;

  const stats = document.createElement('div');
  stats.className = 'cf-stats';
  if (f.additions > 0) {
    const a = document.createElement('span');
    a.className = 'cf-add';
    a.textContent = `+${f.additions} eklendi`;
    stats.appendChild(a);
  }
  if (f.deletions > 0) {
    const d = document.createElement('span');
    d.className = 'cf-del';
    d.textContent = `-${f.deletions} silindi`;
    stats.appendChild(d);
  }

  titleWrap.append(statusBadge, pathSpan, stats);

  const actions = document.createElement('div');
  actions.className = 'diff-panel-actions';

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'diff-context-toggle';
  toggleBtn.textContent = showFullChangesDiff ? 'Bağlamı Daralt' : 'Tüm Dosyayı Göster';
  toggleBtn.addEventListener('click', () => {
    showFullChangesDiff = !showFullChangesDiff;
    renderChangesDiffPanel();
  });

  actions.append(toggleBtn);
  if (!selectedChangesRunId) {
    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'diff-undo-file-btn';
    undoBtn.textContent = '↩ Bu Dosyayı Geri Al';
    undoBtn.addEventListener('click', async () => {
      if (!confirm(`"${f.relativePath}" dosyasındaki değişiklikler geri alınsın mı?`)) return;
      const chat = active();
      if (!chat) return;
      const r = await window.api.undoFile(chat.id, f.path);
      notice(chat, r.message);
      await updateUndo();
      if (!currentChangesDetails?.totalFiles) closeChangesModal();
      else await openChangesModal();
    });
    actions.append(undoBtn);
  }
  head.append(titleWrap, actions);
  panel.appendChild(head);

  // Diff İçeriği
  const content = document.createElement('div');
  content.className = 'diff-content';

  if (f.isBinary) {
    const binMsg = document.createElement('div');
    binMsg.className = 'diff-binary-notice';
    binMsg.textContent = 'İkili (binary) dosya: metin diff görüntülenemez.';
    content.appendChild(binMsg);
    panel.appendChild(content);
    return;
  }

  const table = document.createElement('div');
  table.className = 'diff-table';

  const lines = f.lines || [];
  let skipping = false;
  let skippedCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const showLine = showFullChangesDiff || line.inContext;

    if (!showLine) {
      skipping = true;
      skippedCount++;
      continue;
    }

    if (skipping) {
      const gapRow = document.createElement('div');
      gapRow.className = 'diff-row gap';
      gapRow.textContent = `… (${skippedCount} değişmeyen satır gizlendi — görmek için tıklayın) …`;
      gapRow.style.cursor = 'pointer';
      gapRow.addEventListener('click', () => {
        showFullChangesDiff = true;
        renderChangesDiffPanel();
      });
      table.appendChild(gapRow);
      skipping = false;
      skippedCount = 0;
    }

    const row = document.createElement('div');
    row.className = `diff-row ${line.type}`;

    const oldCol = document.createElement('span');
    oldCol.className = 'diff-col-old';
    oldCol.textContent = line.oldLineNo != null ? String(line.oldLineNo) : '';

    const newCol = document.createElement('span');
    newCol.className = 'diff-col-new';
    newCol.textContent = line.newLineNo != null ? String(line.newLineNo) : '';

    const markerCol = document.createElement('span');
    markerCol.className = 'diff-col-marker';
    markerCol.textContent = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';

    const codeCol = document.createElement('span');
    codeCol.className = 'diff-col-code';
    codeCol.textContent = line.text;

    row.append(oldCol, newCol, markerCol, codeCol);
    table.appendChild(row);
  }

  if (skipping) {
    const gapRow = document.createElement('div');
    gapRow.className = 'diff-row gap';
    gapRow.textContent = `… (${skippedCount} değişmeyen satır gizlendi) …`;
    gapRow.style.cursor = 'pointer';
    gapRow.addEventListener('click', () => {
      showFullChangesDiff = true;
      renderChangesDiffPanel();
    });
    table.appendChild(gapRow);
  }

  content.appendChild(table);
  panel.appendChild(content);
}

function renderMessages() {
  const chat = active();
  setPendingApproval(null);
  messagesEl.replaceChildren();
  if (!chat) return;

  const results = {};
  for (const m of chat.messages) if (m.role === 'tool') results[m.tool_call_id] = m.content;

  for (const m of chat.messages) {
    if (m.role === 'user') {
      renderUserContent(addRow(messagesEl, 'user-msg'), m.content);
    } else if (m.role === 'notice') {
      addRow(messagesEl, 'notice').textContent = m.content;
    } else if (m.role === 'changes_summary') {
      addRow(messagesEl).appendChild(renderChangesSummary(m));
    } else if (m.role === 'assistant') {
      if (m.reasoning) {
        const r = makeReasoningEl();
        r.querySelector('pre').textContent = m.reasoning;
        addRow(messagesEl).appendChild(r);
      }
      if (m.content) setMarkdown(addRow(messagesEl, 'assistant-msg'), textOf(m.content));
      for (const tc of m.tool_calls || []) {
        let args = null;
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* boş bırak */ }
        const t = makeToolEl(tc.function.name, args, results[tc.id] ?? '(sonuç yok)');
        addRow(messagesEl).appendChild(t.el);
      }
    }
  }

  if (chat.lastError) addRow(messagesEl, 'error-msg').textContent = chat.lastError;
  if (live[chat.id]) {
    if (live[chat.id].textEl) setMarkdown(live[chat.id].textEl, live[chat.id].text);
    messagesEl.appendChild(live[chat.id].el);
  } else {
    renderActions(chat);
  }
  if (!messagesEl.children.length) messagesEl.appendChild(emptyEl);
  scrollDown();
  updateStatus();
}

function renderChangesSummary(summary) {
  const card = el('div', 'run-changes-summary');
  const heading = el('strong', null, 'Bu çalışmada dosyalar değişti');
  const stats = el('span', 'run-changes-stats', `${summary.files} dosya  +${summary.additions}  −${summary.deletions}`);
  const actions = el('div', 'run-changes-actions');
  const view = el('button', null, 'Değişiklikleri görüntüle');
  view.addEventListener('click', () => openChangesModal(null, summary.runId));
  actions.appendChild(view);
  if (summary.undone) {
    actions.appendChild(el('span', 'run-changes-undone', 'Geri alındı'));
  } else {
    const undo = el('button', 'run-changes-undo', 'Bu çalışmayı geri al');
    undo.addEventListener('click', async () => {
      const chat = chats.find((c) => c.id === summary.chatId) || active();
      if (!chat || running.has(chat.id)) return;
      if (!confirm(`Bu çalışmada değişen ${summary.files} dosya geri alınsın mı?`)) return;
      const result = await window.api.undoRun(chat.id, summary.runId);
      if (result.ok) summary.undone = true;
      saveChats();
      notice(chat, result.message);
      await updateUndo();
    });
    actions.appendChild(undo);
  }
  card.append(heading, stats, actions);
  return card;
}

// Son mesajın altındaki işlem düğmeleri: yeniden üret, son mesajı düzenle, planı uygula
function renderActions(chat) {
  const msgs = chat.messages;
  if (!msgs.some((m) => m.role === 'user')) return;
  const bar = addRow(messagesEl, 'msg-actions');
  const lastIdx = (() => { for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') return i; return -1; })();

  const regen = el('button', null, '↻ Yeniden üret');
  regen.addEventListener('click', () => regenerate());
  bar.appendChild(regen);

  if (typeof msgs[lastIdx].content === 'string') {
    const edit = el('button', null, '✎ Son mesajı düzenle');
    edit.addEventListener('click', () => {
      inputEl.value = msgs[lastIdx].content;
      chat.messages = msgs.slice(0, lastIdx);
      chat.lastError = null;
      saveChats();
      renderAll();
      autosize();
      inputEl.focus();
    });
    bar.appendChild(edit);
  }

  const last = msgs[msgs.length - 1];
  if (chat.planMode && last?.role === 'assistant' && !last.tool_calls?.length && last.content) {
    const go = el('button', 'primary', '✔ Planı onayla ve uygula');
    go.addEventListener('click', () => {
      chat.planMode = false;
      renderTopbar();
      submit('Planı onaylıyorum, şimdi uygula.');
    });
    bar.appendChild(go);
  }
}

function updateSendBtn() {
  const isRunning = running.has(activeId);
  sendBtn.textContent = isRunning ? 'Durdur' : 'Gönder';
  sendBtn.classList.toggle('stop', isRunning);
}

function updateStatus() {
  const s = $('status');
  const text = live[activeId]?.status || '';
  s.hidden = !text;
  s.textContent = text;
}

function renderAll() {
  renderSidebar();
  renderTopbar();
  renderMessages();
  updateSendBtn();
}

// ------------------------------------------------------------------ sohbet işlemleri
function deleteChat(id) {
  if (!confirm('Bu oturum silinsin mi?')) return;
  window.api.forget(id); // çalışıyorsa durdurur, geri alma yedeklerini siler
  chats = chats.filter((c) => c.id !== id);
  delete live[id];
  running.delete(id);
  saveChats();
  if (activeId === id) activeId = chats[0]?.id || null;
  if (!activeId) newChat(); else renderAll();
}

function buildContent(text) {
  if (!attachments.length) return text;
  let full = text;
  const images = [];
  for (const a of attachments) {
    if (a.kind === 'text') full += `\n\n[Ek dosya: ${a.name}]\n\`\`\`\n${a.text}\n\`\`\``;
    else images.push({ type: 'image_url', image_url: { url: a.data } });
  }
  return images.length ? [{ type: 'text', text: full }, ...images] : full;
}

function confirmModel(model) {
  const info = modelInfo.get(model);
  if (info && !info.tools) {
    return confirm(`"${model}" araç çağırmayı (tool calling) desteklemiyor görünüyor; dosya ve komut işlemleri çalışmayabilir. Yine de devam edilsin mi?`);
  }
  if (info && !info.images && attachments.some((a) => a.kind === 'image')) {
    return confirm(`"${model}" görsel girdiyi desteklemiyor görünüyor. Yine de gönderilsin mi?`);
  }
  return true;
}

// Mesajı ekler ve çalışmayı başlatır
function submit(text) {
  const chat = active();
  if (!chat || running.has(chat.id)) return false;
  if (!settings.hasApiKey) { openSettings(); return false; }
  const model = modelInput.value.trim();
  if (!model) { modelInput.focus(); return false; }
  if (!confirmModel(model)) return false;

  chat.model = model;
  chat.messages.push({ role: 'user', content: buildContent(text) });
  if (chat.title === NEW_TITLE) chat.title = text.length > 42 ? text.slice(0, 42) + '…' : text;
  attachments = [];
  renderAttachments();
  startRun(chat);
  return true;
}

function startRun(chat) {
  chat.lastError = null;
  running.add(chat.id);
  live[chat.id] = { el: document.createElement('div'), textEl: null, text: '', tools: {}, raf: 0, reasoningEl: null, reasoning: '', status: '' };
  saveChats();
  renderAll();

  window.api.send({
    chatId: chat.id,
    messages: chat.messages,
    model: chat.model,
    modelContextTokens: modelInfo.get(chat.model)?.context || 0,
    workspace: chat.workspace,
    planMode: !!chat.planMode,
    subagentEnabled: isChatSubagentOn(chat),
    subagentModel: getActiveSubagentModel(),
    permissionMode: currentPermissionMode,
    noTools: modelInfo.get(chat.model)?.tools === false,
    webSearch: !!settings.webSearch,
    reasoningEffort: settings.reasoningEffort || '',
    spent: chat.cost || 0,
    stepsSinceMd: chat.stepsSinceMd || 0,
    totalSteps: chat.totalSteps || 0
  }).catch((err) => finish(chat.id, null, String(err.message || err), false));
}

function regenerate() {
  const chat = active();
  if (!chat || running.has(chat.id)) return;
  let i = chat.messages.length - 1;
  while (i >= 0 && chat.messages[i].role !== 'user') i--;
  if (i < 0) return;
  if (!settings.hasApiKey) { openSettings(); return; }
  const model = modelInput.value.trim();
  if (!model) { modelInput.focus(); return; }
  if (!confirmModel(model)) return;
  chat.model = model;
  chat.messages = chat.messages.slice(0, i + 1);
  startRun(chat);
}

async function sendMessage() {
  const chat = active();
  if (!chat) return;
  if (running.has(chat.id)) { window.api.stop(chat.id); return; }

  const text = inputEl.value.trim();
  if (text.startsWith('/') && (await runSlash(text))) return;
  if (!text && !attachments.length) return;

  if (!submit(text || 'Ekteki dosyalara bak.')) return;
  inputEl.value = '';
  autosize();
  hideSlashHints();
}

async function finish(chatId, messages, error, aborted, extra) {
  const chat = chats.find((c) => c.id === chatId);
  const L = live[chatId];
  if (L?.raf) cancelAnimationFrame(L.raf);
  delete live[chatId];
  running.delete(chatId);
  if (!chat) return;
  if (messages) chat.messages = messages;
  if (extra?.runId) {
    try {
      const changes = await window.api.checkpointRunDetails(chatId, extra.runId);
      if (changes?.totalFiles > 0 && !chat.messages.some((m) => m.role === 'changes_summary' && m.runId === extra.runId)) {
        chat.messages.push({
          role: 'changes_summary', chatId, runId: extra.runId,
          files: changes.totalFiles, additions: changes.totalAdditions, deletions: changes.totalDeletions
        });
      }
    } catch { /* değişiklik özeti yüklenemezse çalışma sonucunu yine göster */ }
  }
  if (extra?.stepsSinceMd !== undefined) chat.stepsSinceMd = extra.stepsSinceMd;
  if (extra?.totalSteps !== undefined) chat.totalSteps = extra.totalSteps;
  chat.lastError = error && !aborted ? error : null;
  if (extra?.verification === 'missing' && !error) {
    chat.messages.push({ role: 'notice', content: '⚠️ Dosyalar değişti ama değişiklikten sonra test/derleme komutu çalıştırılmadı; sonuç doğrulanmadı. İstersen "testleri çalıştır" yaz.' });
  }
  saveChats();
  if (chatId === activeId) renderAll(); else renderSidebar();
  if (chatId === activeId) await updateUndo();
}

// ------------------------------------------------------------------ slash komutları
const SLASH = {
  '/help': 'Komutları listeler',
  '/init': 'Projeyi inceleyip EMO.md talimat dosyası oluşturur',
  '/md': 'Yapılanları ve kalınan yeri EMO.md dosyasına şimdi kaydeder',
  '/plan': 'Plan modunu aç/kapat',
  '/subagent': 'Bu sohbette Alt Ajanı (Subagent) aç/kapat veya modelini seç: /subagent <aç|kapat|model>',
  '/mode': 'İzin modunu değiştirir: /mode <sıkı|normal|oto|turbo>',
  '/diff': 'Yapılan dosya değişikliklerini ve farkları incele',
  '/changes': 'Yapılan dosya değişikliklerini ve farkları incele',
  '/compact': 'Sohbeti özetleyerek bağlamı küçültür',
  '/undo': 'Son çalışmadaki dosya değişikliklerini geri alır',
  '/clear': 'Sohbet mesajlarını temizler',
  '/model': 'Modeli değiştirir: /model <ad>'
};

function notice(chat, text, forModel = false) {
  chat.messages.push({ role: 'notice', content: text, forModel });
  saveChats();
  if (chat.id === activeId) renderMessages();
}

async function doUndo(chat) {
  const r = await window.api.undo(chat.id);
  notice(chat, r.message);
  updateUndo();
}

async function doCompact(chat) {
  const msgs = chat.messages.filter((m) => m.role !== 'notice');
  if (msgs.length < 2) { notice(chat, 'Özetlenecek kadar mesaj yok.'); return; }
  const model = modelInput.value.trim() || chat.model;
  running.add(chat.id);
  live[chat.id] = { el: document.createElement('div'), textEl: null, text: '', tools: {}, raf: 0, reasoningEl: null, reasoning: '', status: 'Sohbet özetleniyor…' };
  renderAll();
  try {
    const r = await window.api.compact({ chatId: chat.id, messages: chat.messages, model });
    chat.cost = (chat.cost || 0) + (r.cost || 0);
    chat.messages = [{ role: 'notice', forModel: true, content: `Önceki konuşmanın özeti:\n${r.summary}` }];
    chat.lastPrompt = 0;
    chat.lastError = null;
  } catch (e) {
    chat.lastError = `Özetleme başarısız: ${e.message}`;
  }
  delete live[chat.id];
  running.delete(chat.id);
  saveChats();
  renderAll();
}

async function doUpdateMd(chat) {
  if (!chat.workspace) { notice(chat, 'Önce bir çalışma klasörü seçmelisin.'); return; }
  const msgs = chat.messages.filter((m) => m.role !== 'notice');
  if (!msgs.length) { notice(chat, 'EMO.md içine kaydedilecek çalışma geçmişi henüz yok.'); return; }
  const model = modelInput.value.trim() || chat.model;
  running.add(chat.id);
  live[chat.id] = { el: document.createElement('div'), textEl: null, text: '', tools: {}, raf: 0, reasoningEl: null, reasoning: '', status: 'EMO.md ilerleme özeti güncelleniyor…' };
  renderAll();
  try {
    const r = await window.api.updateMd({
      chatId: chat.id,
      messages: chat.messages,
      model,
      workspace: chat.workspace,
      subagentModel: getActiveSubagentModel(),
      totalSteps: chat.totalSteps || 0
    });
    chat.cost = (chat.cost || 0) + (r.cost || 0);
    chat.stepsSinceMd = 0;
    chat.lastError = null;
    chat.messages.push({
      role: 'notice',
      content: `📌 EMO.md güncellendi (yapılan işlemler ve kalınan yer kaydedildi). Sonraki sohbete geçtiğinde ajan bu dosyadan okuyarak kaldığı yerden devam edecek.`
    });
  } catch (e) {
    chat.lastError = `EMO.md güncellenemedi: ${e.message}`;
  }
  delete live[chat.id];
  running.delete(chat.id);
  saveChats();
  renderAll();
}

// true: komut işlendi (mesaj olarak gönderilmesin)
async function runSlash(text) {
  const chat = active();
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ').trim();
  if (!SLASH[cmd]) return false;
  inputEl.value = '';
  autosize();
  hideSlashHints();

  switch (cmd) {
    case '/help':
      notice(chat, Object.entries(SLASH).map(([k, v]) => `${k} — ${v}`).join('\n'));
      break;
    case '/plan':
      chat.planMode = !chat.planMode;
      saveChats();
      renderTopbar();
      notice(chat, chat.planMode ? 'Plan modu açık: model yalnızca inceler ve plan sunar.' : 'Plan modu kapalı.');
      break;
    case '/subagent': {
      const lower = arg.toLowerCase().trim();
      if (!lower) {
        chat.subagentEnabled = !isChatSubagentOn(chat);
        saveChats();
        renderTopbar();
        notice(chat, chat.subagentEnabled
          ? `🤖 Alt Ajan (Subagent) bu sohbet için AÇILDI (Model: ${getActiveSubagentModel()}).`
          : '🤖 Alt Ajan (Subagent) bu sohbet için KAPATILDI.');
      } else if (['ac', 'aç', 'on', 'aktif', 'true'].includes(lower)) {
        chat.subagentEnabled = true;
        saveChats();
        renderTopbar();
        notice(chat, `🤖 Alt Ajan (Subagent) bu sohbet için AÇILDI (Model: ${getActiveSubagentModel()}).`);
      } else if (['kapat', 'off', 'kapali', 'kapalı', 'false'].includes(lower)) {
        chat.subagentEnabled = false;
        saveChats();
        renderTopbar();
        notice(chat, '🤖 Alt Ajan (Subagent) bu sohbet için KAPATILDI.');
      } else {
        await selectSubagentModel(arg);
        chat.subagentEnabled = true;
        saveChats();
        renderTopbar();
        notice(chat, `🤖 Alt Ajan (Subagent) modeli değiştirildi ve açıldı: ${arg}`);
      }
      break;
    }
    case '/mode': {
      const lower = arg.toLowerCase().trim();
      let target = null;
      if (['siki', 'sıkı', 'strict'].includes(lower)) target = 'strict';
      else if (['normal'].includes(lower)) target = 'normal';
      else if (['oto', 'auto'].includes(lower)) target = 'auto';
      else if (['turbo'].includes(lower)) target = 'turbo';

      if (target) {
        setPermissionMode(target, true);
        notice(chat, `İzin modu değiştirildi: ${PERM_MODES[target].label} — ${PERM_MODES[target].desc}`);
      } else {
        const lines = [
          `Mevcut İzin Modu: ${PERM_MODES[currentPermissionMode].label} (${PERM_MODES[currentPermissionMode].desc})`,
          '',
          'Kullanılabilir modlar:',
          '• /mode sıkı   — Her komudu ve dosya işlemini sorar',
          '• /mode normal — Güvenlileri hatırlar, riskli kodlarda mutlaka uyarır',
          '• /mode oto    — Kendin karar ver: güvenli işlemleri doğrudan çalıştırır',
          '• /mode turbo  — Tüm kodlara izin ver: tam otomatik, sormadan çalıştırır'
        ];
        notice(chat, lines.join('\n'));
      }
      break;
    }
    case '/diff':
    case '/changes':
      await openChangesModal();
      break;
    case '/undo': await doUndo(chat); break;
    case '/compact': await doCompact(chat); break;
    case '/md': await doUpdateMd(chat); break;
    case '/clear':
      if (!confirm('Bu sohbetteki tüm mesajlar silinsin mi?')) { inputEl.value = text; return true; }
      window.api.forget(chat.id);
      chat.messages = [];
      chat.title = NEW_TITLE;
      chat.cost = 0;
      chat.lastPrompt = 0;
      chat.stepsSinceMd = 0;
      chat.totalSteps = 0;
      chat.lastError = null;
      saveChats();
      renderAll();
      break;
    case '/model':
      if (!arg) {
        openModelDropdown();
        $('model-search')?.focus();
        break;
      }
      chat.model = arg;
      settings.defaultModel = arg;
      window.api.setSettings({ defaultModel: arg });
      saveChats();
      renderTopbar();
      notice(chat, `Model değiştirildi: ${arg}`);
      break;
    case '/init':
      if (!chat.workspace) { notice(chat, 'Önce bir çalışma klasörü seç.'); break; }
      if (chat.planMode) { notice(chat, 'Plan modu açık olduğu için dosyaya yazılamıyor. /plan ile plan modunu kapatıp /init komutunu yeniden çalıştır.'); break; }
      submit('Bu projeyi incele (dosya yapısı, kullanılan teknolojiler, build/test komutları, kod stili). Sonra çalışma klasörünün köküne, gelecekteki oturumlarda sana yol gösterecek kısa ve net bir EMO.md dosyası yaz. Dosya mevcutsa önce oku ve iyileştir.');
      break;
  }
  return true;
}

function hideSlashHints() {
  $('slash-hints').hidden = true;
  slashIndex = 0;
}

function syncSlashActive() {
  const buttons = [...$('slash-hints').querySelectorAll('button')];
  if (!buttons.length) return;
  slashIndex = ((slashIndex % buttons.length) + buttons.length) % buttons.length;
  buttons.forEach((b, idx) => {
    b.classList.toggle('active', idx === slashIndex);
    b.setAttribute('aria-selected', idx === slashIndex ? 'true' : 'false');
  });
}

function updateSlashHints() {
  const box = $('slash-hints');
  const v = inputEl.value;
  if (!v.startsWith('/') || v.includes(' ') || v.includes('\n')) { hideSlashHints(); return; }
  const matches = Object.entries(SLASH).filter(([k]) => k.startsWith(v.toLowerCase()));
  box.replaceChildren();
  slashIndex = 0;
  matches.forEach(([k, d], idx) => {
    const b = el('button', idx === 0 ? 'active' : null);
    b.type = 'button';
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', idx === 0 ? 'true' : 'false');
    b.dataset.cmd = k;
    b.append(el('b', null, k), el('span', 'dim', d));
    b.addEventListener('mouseenter', () => { slashIndex = idx; syncSlashActive(); });
    b.addEventListener('click', () => {
      if (k === '/model' || k === '/mode') {
        inputEl.value = `${k} `;
        inputEl.focus();
        hideSlashHints();
      } else {
        runSlash(k);
      }
    });
    box.appendChild(b);
  });
  box.hidden = !matches.length;
}

// ------------------------------------------------------------------ ekler
function renderAttachments() {
  const box = $('attachments');
  box.replaceChildren();
  attachments.forEach((a, i) => {
    const chip = el('span', 'att-chip');
    if (a.kind === 'image') {
      const img = document.createElement('img');
      img.src = a.data;
      img.alt = '';
      chip.appendChild(img);
    }
    chip.append(a.name);
    const x = el('button', null, '✕');
    x.type = 'button';
    x.title = 'Kaldır';
    x.addEventListener('click', () => { attachments.splice(i, 1); renderAttachments(); });
    chip.appendChild(x);
    box.appendChild(chip);
  });
  box.hidden = !attachments.length;
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

async function addFiles(files) {
  for (const f of files) {
    if (attachments.length >= MAX_ATTACHMENTS) { notice(active(), `En fazla ${MAX_ATTACHMENTS} ek eklenebilir.`); break; }
    try {
      if (/^image\/(png|jpe?g|gif|webp)$/.test(f.type)) {
        if (f.size > MAX_IMAGE_BYTES) { notice(active(), `${f.name}: görsel 5 MB'tan büyük.`); continue; }
        attachments.push({ kind: 'image', name: f.name || 'görsel', data: await readAsDataURL(f) });
      } else {
        if (f.size > MAX_TEXT_BYTES) { notice(active(), `${f.name}: dosya 200 KB'tan büyük.`); continue; }
        const buf = new Uint8Array(await f.arrayBuffer());
        if (buf.subarray(0, 8000).includes(0)) { notice(active(), `${f.name}: ikili dosyalar eklenemez.`); continue; }
        attachments.push({ kind: 'text', name: f.name, text: new TextDecoder().decode(buf) });
      }
    } catch (e) {
      notice(active(), `${f.name}: okunamadı (${e.message})`);
    }
  }
  renderAttachments();
}

['dragover', 'drop'].forEach((t) => window.addEventListener(t, (e) => e.preventDefault()));
window.addEventListener('drop', (e) => {
  if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]);
});
inputEl.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (files.length) { e.preventDefault(); addFiles(files); }
});

// ------------------------------------------------------------------ canlı olaylar
function scheduleMarkdown(L) {
  if (L.raf) return;
  L.raf = requestAnimationFrame(() => {
    L.raf = 0;
    if (L.textEl) setMarkdown(L.textEl, L.text, { streaming: true });
  });
}

function renderDiff(pre, text) {
  pre.classList.add('diff');
  for (const line of text.split('\n')) {
    const c = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : line[0] === '…' ? 'gap' : 'ctx';
    pre.appendChild(el('span', `dl ${c}`, line + '\n'));
  }
}

// Enter tuşuyla onaylanabilecek son onay kartı: { id, answer, setHint }
let pendingApproval = null;

function setPendingApproval(entry) {
  if (pendingApproval && pendingApproval !== entry && pendingApproval.setHint) {
    pendingApproval.setHint(false);
  }
  pendingApproval = entry;
  if (entry && entry.setHint) entry.setHint(true);
}

function makeApprovalCard(e) {
  const card = el('div', 'approval' + (e.warning ? ' risky' : ''));
  const head = el('div', 'approval-head');
  head.appendChild(el('h3', null, e.title));
  const modeKey = e.mode || currentPermissionMode;
  const modeInfo = PERM_MODES[modeKey] || PERM_MODES.normal;
  const badge = el('span', 'approval-badge', `${modeInfo.label} mod`);
  head.appendChild(badge);

  let warnBox = null;
  if (e.warning) {
    warnBox = el('div', 'approval-warning-box');
    warnBox.appendChild(el('span', 'approval-warning-icon', '⚠️'));
    const warnText = el('div', null);
    warnText.appendChild(el('strong', null, 'Riskli İşlem Uyarısı: '));
    warnText.appendChild(document.createTextNode(e.warning));
    warnBox.appendChild(warnText);
  }

  const pre = el('pre');
  if (e.format === 'diff') renderDiff(pre, e.detail); else pre.textContent = e.detail;
  const actions = el('div', 'actions');
  let settled = false;
  const answer = (decision) => {
    if (settled) return;
    settled = true;
    if (pendingApproval && pendingApproval.id === e.id) setPendingApproval(null);
    window.api.approve(e.id, decision);
    actions.replaceChildren(el('span', 'result', decision === 'deny' ? 'Reddedildi.' : decision === 'allow_session' ? 'İzin verildi (bu oturum için).' : 'İzin verildi.'));
  };
  const allow = el('button', 'allow', 'İzin ver');
  allow.addEventListener('click', () => answer('allow'));
  actions.appendChild(allow);

  const allowBase = 'İzin ver';
  const setHint = (active) => {
    allow.textContent = active ? `${allowBase} (Enter)` : allowBase;
    if (active) allow.title = 'Enter tuşuna basarak da onaylayabilirsin';
    else allow.removeAttribute('title');
  };
  if (e.sessionLabel) {
    const sess = el('button', null, e.sessionLabel);
    sess.addEventListener('click', () => answer('allow_session'));
    actions.appendChild(sess);
  }
  const deny = el('button', null, 'Reddet');
  deny.addEventListener('click', () => answer('deny'));
  actions.appendChild(deny);

  card.tabIndex = 0;

  card.appendChild(head);
  if (warnBox) card.appendChild(warnBox);
  card.append(pre, actions);

  if (e.id) setPendingApproval({ id: e.id, answer, setHint, card });
  return card;
}

function makeQuestionCard(e) {
  const card = el('div', 'approval question');
  card.appendChild(el('h3', null, e.question));
  const actions = el('div', 'actions wrap');
  const reply = (text) => {
    window.api.answer(e.id, text);
    card.replaceChildren(el('h3', null, e.question), el('span', 'result', `Yanıtın: ${text}`));
  };
  for (const o of e.options || []) {
    const b = el('button', null, o);
    b.addEventListener('click', () => reply(o));
    actions.appendChild(b);
  }
  card.appendChild(actions);
  const row = el('div', 'actions');
  const input = el('input', 'q-input');
  input.type = 'text';
  input.placeholder = 'Yanıtını yaz…';
  const ok = el('button', 'allow', 'Gönder');
  const go = () => { if (input.value.trim()) reply(input.value.trim()); };
  ok.addEventListener('click', go);
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
  row.append(input, ok);
  card.appendChild(row);
  return card;
}

window.api.onEvent((e) => {
  if (e.type === 'fatal') {
    const text = `⚠️ Beklenmeyen hata: ${e.error}`;
    const target = (e.chatId && chats.find((c) => c.id === e.chatId)) || chats.find((c) => c.id === activeId);
    if (target) { target.messages.push({ role: 'notice', content: text }); saveChats(); }
    const Lf = live[e.chatId] || live[activeId];
    if (Lf) addRow(Lf.el, 'notice').textContent = text;
    else if (target && target.id === activeId) renderAll();
    return;
  }
  if (e.type === 'done' || e.type === 'error') {
    finish(e.chatId, e.messages, e.type === 'error' ? e.error : null, e.aborted, e);
    return;
  }
  const chat = chats.find((c) => c.id === e.chatId);
  if (e.type === 'usage' && chat) {
    chat.cost = (chat.cost || 0) + (e.cost || 0);
    if (!e.subagent) chat.lastPrompt = e.prompt || 0;
    if (e.chatId === activeId) updateUsage();
    return;
  }
  if (e.type === 'step_progress' && chat) {
    chat.stepsSinceMd = e.stepsSinceMd || 0;
    chat.totalSteps = e.totalSteps || 0;
    saveChats();
    if (e.chatId === activeId) updateUsage();
    return;
  }
  if (e.type === 'md_updated' && chat) {
    chat.stepsSinceMd = 0;
    if (e.totalSteps !== undefined) chat.totalSteps = e.totalSteps;
    const msgText = `📌 ${chat.totalSteps}. adıma ulaşıldı: Yapılan işlemler ve kalınan yer otomatik olarak ${e.file || 'EMO.md'} dosyasına kaydedildi. Dilediğin zaman yeni bir sohbete (+ Yeni oturum) geçerek şişmiş bağlamdan ve gereksiz token maliyetinden kurtulabilirsin.`;
    chat.messages.push({ role: 'notice', content: msgText });
    saveChats();
    const Lcur = live[e.chatId];
    if (Lcur) addRow(Lcur.el, 'notice').textContent = msgText;
    if (e.chatId === activeId) { updateUsage(); updateUndo(); }
    return;
  }
  if (e.type === 'md_update_error' && chat) {
    const warnText = `⚠️ EMO.md otomatik güncellenemedi: ${e.error}`;
    chat.messages.push({ role: 'notice', content: warnText });
    saveChats();
    const Lcur = live[e.chatId];
    if (Lcur) addRow(Lcur.el, 'notice').textContent = warnText;
    return;
  }
  const L = live[e.chatId];
  if (!L) return;

  if (e.type === 'status') {
    L.status = e.text || '';
    if (e.chatId === activeId) updateStatus();
    return;
  }

  const stick = e.chatId === activeId && isNearBottom();
  switch (e.type) {
    case 'reasoning':
      if (!L.reasoningEl) { L.reasoningEl = makeReasoningEl(); addRow(L.el).appendChild(L.reasoningEl); }
      L.reasoning += e.text;
      L.reasoningEl.querySelector('pre').textContent = L.reasoning;
      break;
    case 'delta':
      if (!L.textEl) L.textEl = addRow(L.el, 'assistant-msg');
      L.text += e.text;
      scheduleMarkdown(L);
      break;
    case 'tool_start': {
      if (L.textEl) setMarkdown(L.textEl, L.text);
      L.textEl = null;
      L.text = '';
      L.reasoningEl = null;
      L.reasoning = '';
      const t = makeToolEl(e.name, e.args);
      L.tools[e.id] = t;
      addRow(L.el).appendChild(t.el);
      break;
    }
    case 'tool_output':
      L.tools[e.id]?.appendOutput(e.text);
      break;
    case 'tool_result':
      L.tools[e.id]?.setResult(e.result, e.attachments);
      break;
    case 'approval':
      addRow(L.el).appendChild(makeApprovalCard(e));
      break;
    case 'question':
      addRow(L.el).appendChild(makeQuestionCard(e));
      break;
  }
  if (stick) scrollDown();
});

// ------------------------------------------------------------------ tema
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const t = settings.theme || 'dark';
  const resolved = t === 'auto' ? (darkQuery.matches ? 'dark' : 'light') : t;
  document.documentElement.dataset.theme = resolved;
}
darkQuery.addEventListener('change', applyTheme);

// ------------------------------------------------------------------ ayarlar penceresi
function syncSandboxNet() {
  const sb = $('sandbox');
  const net = $('sandbox-net');
  net.disabled = sb.disabled || !sb.checked;
}

function openSettings() {
  $('api-key').value = '';
  $('api-key').placeholder = settings.hasApiKey ? '•••••••• (kayıtlı; değiştirmek için yeni anahtar yaz)' : 'sk-or-v1-…';
  $('key-info').textContent = settings.hasApiKey
    ? (settings.keyEncrypted ? 'Anahtar işletim sistemi anahtarlığıyla şifrelenerek saklanıyor.' : 'Uyarı: Bu sistemde şifreli depolama kullanılamıyor; anahtar düz metin olarak saklanıyor (dosya izni 600).')
    : (sysInfo.encryptionAvailable ? 'Anahtar şifrelenerek saklanacak.' : 'Uyarı: Şifreli depolama yok; anahtar düz metin saklanacak (dosya izni 600).');
  $('theme').value = settings.theme || 'dark';
  $('fallback-model').value = settings.fallbackModel || '';
  if ($('subagent-model-setting')) $('subagent-model-setting').value = settings.subagentModel || DEFAULT_SUBAGENT_MODEL;
  $('max-steps').value = settings.maxSteps ?? '';
  if ($('md-update-steps')) $('md-update-steps').value = settings.mdUpdateSteps ?? '';
  $('cmd-timeout').value = settings.commandTimeout ?? '';
  $('temperature').value = settings.temperature ?? '';
  $('budget').value = settings.budget ?? '';
  $('budget-info').textContent = 'OpenRouter kullanım maliyetine göre sohbet bütçesini uygular.';
  $('max-context-tokens').value = settings.maxContextTokens ?? '';
  if ($('subagent-budget')) $('subagent-budget').value = settings.subagentBudget ?? '';
  $('custom-prompt').value = settings.customPrompt || '';
  const pMode = settings.permissionMode || (settings.autoApprove ? 'auto' : 'normal');
  const radios = document.getElementsByName('perm-mode');
  for (const r of radios) r.checked = (r.value === pMode);
  document.querySelectorAll('.perm-radio-card').forEach((card) => {
    card.classList.toggle('active', card.dataset.mode === pMode);
  });
  $('sandbox').checked = !!settings.sandbox;
  $('sandbox-net').checked = !!settings.sandboxNetwork;
  $('sandbox').disabled = !sysInfo.sandboxAvailable;
  syncSandboxNet();
  $('sandbox-info').textContent = sysInfo.sandboxAvailable
    ? 'Sandbox\'ta ev dizinin boştur ve yalnızca çalışma klasörü yazılabilir; sistem salt okunurdur. Ağ erişimi kapalıyken npm install gibi komutlar çalışmaz.'
    : 'bubblewrap (bwrap) kurulu değil: sudo dnf install bubblewrap';
  $('modal').classList.remove('hidden');
  $('api-key').focus();
}
function closeSettings() { $('modal').classList.add('hidden'); }
$('sandbox').addEventListener('change', syncSandboxNet);

async function applySettingsPatch(patch) {
  settings = await window.api.setSettings(patch);
  sysInfo = await window.api.sysInfo();
  applyTheme();
  updateUsage();
}

function classifyModelFamily(m) {
  const id = String(m.id || '').toLowerCase();
  const name = String(m.name || '').toLowerCase();
  if (id.startsWith('anthropic/') || id.includes('claude') || name.includes('claude')) return 'claude';
  if (id.startsWith('google/') || id.includes('gemini') || id.includes('gemma') || name.includes('gemini')) return 'gemini';
  if (id.startsWith('openai/') || id.includes('gpt-') || id.includes('chatgpt') || /\/o[134](-|$)/.test(id)) return 'gpt';
  if (id.startsWith('deepseek/') || id.includes('deepseek') || name.includes('deepseek')) return 'deepseek';
  if (id.startsWith('qwen/') || id.includes('qwen') || id.includes('qwq') || name.includes('qwen')) return 'qwen';
  if (id.startsWith('meta-llama/') || id.includes('llama') || name.includes('llama')) return 'llama';
  if (id.startsWith('x-ai/') || id.includes('grok') || name.includes('grok')) return 'grok';
  if (id.startsWith('mistralai/') || id.includes('mistral') || id.includes('mixtral') || id.includes('codestral') || id.includes('pixtral') || id.includes('ministral')) return 'mistral';
  return 'other';
}

function formatPricePerM(perM) {
  const n = Number(perM);
  if (!Number.isFinite(n) || n <= 0) return '$0';
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;
}

function getFilteredModels() {
  const q = modelSearchQuery.trim().toLowerCase();
  return allModels.filter((m) => {
    if (modelFilterFamily !== 'all' && m.family !== modelFilterFamily) return false;
    if (modelFilterCaps.has('tools') && !m.tools) return false;
    if (modelFilterCaps.has('images') && !m.images) return false;
    if (modelFilterCaps.has('free') && !m.free) return false;
    if (q) {
      const hay = `${m.id} ${m.name} ${m.family}`.toLowerCase();
      for (const part of q.split(/\s+/)) {
        if (part && !hay.includes(part)) return false;
      }
    }
    return true;
  });
}

function updateFamilyChipCounts() {
  const capFiltered = allModels.filter((m) => {
    if (modelFilterCaps.has('tools') && !m.tools) return false;
    if (modelFilterCaps.has('images') && !m.images) return false;
    if (modelFilterCaps.has('free') && !m.free) return false;
    return true;
  });
  const counts = { all: capFiltered.length };
  for (const m of capFiltered) {
    counts[m.family] = (counts[m.family] || 0) + 1;
  }
  const labels = {
    all: 'Tümü',
    claude: 'Claude',
    gemini: 'Gemini',
    gpt: 'GPT / OpenAI',
    deepseek: 'DeepSeek',
    qwen: 'Qwen',
    llama: 'Llama',
    grok: 'Grok',
    mistral: 'Mistral',
    other: 'Diğer'
  };
  document.querySelectorAll('#model-family-filters .filter-chip').forEach((btn) => {
    const fam = btn.dataset.family;
    const base = labels[fam] || fam;
    const c = counts[fam] || 0;
    btn.textContent = allModels.length ? `${base} (${c})` : base;
    btn.classList.toggle('active', fam === modelFilterFamily);
  });

  const famFiltered = allModels.filter((m) => modelFilterFamily === 'all' || m.family === modelFilterFamily);
  const capLabels = {
    tools: '🔧 Araç destekli',
    images: '🖼 Görsel',
    free: '⚡ Ücretsiz'
  };
  document.querySelectorAll('#model-cap-filters .cap-chip').forEach((btn) => {
    const cap = btn.dataset.cap;
    const base = capLabels[cap] || btn.textContent;
    const c = famFiltered.filter((m) => !!m[cap]).length;
    const isActive = modelFilterCaps.has(cap);
    btn.textContent = allModels.length ? `${base} (${c})` : base;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  });
}

function renderModelDropdown() {
  const listEl = $('model-list');
  const countEl = $('model-count');
  if (!listEl || !countEl) return;

  updateFamilyChipCounts();
  renderRuntimeOptions();
  const filtered = getFilteredModels();
  countEl.textContent = `${filtered.length} / ${allModels.length} model`;

  listEl.replaceChildren();
  if (!allModels.length) {
    listEl.appendChild(el('div', 'model-empty', 'Modeller yükleniyor veya API bağlantısı kurulamadı. Yenile (↻) düğmesini deneyin.'));
    return;
  }
  if (!filtered.length) {
    listEl.appendChild(el('div', 'model-empty', 'Seçili filtrelere uyan model bulunamadı.'));
    return;
  }

  if (modelFocusIdx >= filtered.length) modelFocusIdx = filtered.length - 1;
  if (modelFocusIdx < 0) modelFocusIdx = -1;

  const currentModel = active()?.model || modelInput.value.trim();

  filtered.forEach((m, idx) => {
    const btn = el('button', 'model-item');
    btn.type = 'button';
    btn.setAttribute('role', 'option');
    if (m.id === currentModel) btn.classList.add('selected');
    if (idx === modelFocusIdx) btn.classList.add('focused');
    btn.title = m.id;

    const top = el('div', 'model-item-top');
    const nameSpan = el('span', 'model-item-name', m.name || m.id);
    const badges = el('div', 'model-item-badges');
    if (m.free) badges.appendChild(el('span', 'model-badge free', 'Ücretsiz'));
    if (m.tools) {
      const tb = el('span', 'model-badge', '🔧');
      tb.title = 'Araç çağırma destekli';
      badges.appendChild(tb);
    } else {
      const wb = el('span', 'model-badge warn', 'araç yok');
      wb.title = 'Araç çağırmayı desteklemiyor';
      badges.appendChild(wb);
    }
    if (m.images) {
      const ib = el('span', 'model-badge', '🖼');
      ib.title = 'Görsel girdi destekli';
      badges.appendChild(ib);
    }
    if (m.context > 0) {
      badges.appendChild(el('span', 'model-badge', fmtTokens(m.context)));
    }
    top.append(nameSpan, badges);

    const sub = el('div', 'model-item-sub');
    sub.appendChild(el('span', 'model-item-id', m.id));
    if (!m.free && (m.promptPrice != null || m.completionPrice != null)) {
      sub.appendChild(el('span', null, `${formatPricePerM(m.promptPrice)} / ${formatPricePerM(m.completionPrice)} · 1M`));
    }

    btn.append(top, sub);
    btn.addEventListener('click', () => selectModel(m.id));
    listEl.appendChild(btn);
  });
}

function openModelDropdown() {
  const dd = $('model-dropdown');
  if (!dd) return;
  dd.hidden = false;
  $('model-toggle')?.setAttribute('aria-expanded', 'true');
  renderModelDropdown();
  requestAnimationFrame(() => {
    const selectedEl = $('model-list')?.querySelector('.model-item.selected');
    selectedEl?.scrollIntoView({ block: 'nearest' });
  });
}

function closeModelDropdown() {
  const dd = $('model-dropdown');
  if (!dd || dd.hidden) return;
  dd.hidden = true;
  modelFocusIdx = -1;
  $('model-toggle')?.setAttribute('aria-expanded', 'false');
}

function selectModel(modelId) {
  const value = String(modelId || '').trim().replace(/:online$/i, '');
  if (!value) return;
  modelInput.value = value;
  modelSearchQuery = '';
  if ($('model-search')) $('model-search').value = '';
  const chat = active();
  if (chat) {
    chat.model = value;
    saveChats();
  }
  settings.defaultModel = value;
  window.api.setSettings({ defaultModel: value });
  closeModelDropdown();
}

async function loadModels({ openAfter = false } = {}) {
  const refreshBtn = $('model-refresh');
  refreshBtn?.classList.add('spinning');
  try {
    const models = await window.api.listModels();
    allModels = (Array.isArray(models) ? models : []).map((m) => ({
      ...m,
      family: classifyModelFamily(m)
    }));
    const dl = $('model-options');
    dl.replaceChildren();
    modelInfo.clear();
    for (const m of allModels) {
      modelInfo.set(m.id, { tools: m.tools, images: m.images, context: m.context });
      const o = document.createElement('option');
      o.value = m.id;
      o.label = `${m.name}${m.tools ? '' : ' (araç desteği yok)'}${m.images ? ' · görsel' : ''}`;
      dl.appendChild(o);
    }
    renderModelDropdown();
    if (openAfter) openModelDropdown();
  } catch (err) {
    console.warn('Model listesi yüklenemedi:', err);
  } finally {
    refreshBtn?.classList.remove('spinning');
  }
}

function exportMarkdown(chat) {
  const out = [`# ${chat.title}`, '', `Model: ${chat.model}${chat.workspace ? ` · Klasör: ${chat.workspace}` : ''}`, ''];
  for (const m of chat.messages) {
    if (m.role === 'user') out.push('## Kullanıcı', '', textOf(m.content), '');
    else if (m.role === 'assistant') {
      if (m.content) out.push('## Asistan', '', textOf(m.content), '');
      for (const tc of m.tool_calls || []) out.push(`> 🔧 \`${tc.function.name}\` ${toolLabel((() => { try { return JSON.parse(tc.function.arguments); } catch { return null; } })())}`, '');
    } else if (m.role === 'notice') out.push(`> ${m.content.replace(/\n/g, '\n> ')}`, '');
  }
  return out.join('\n');
}

// ------------------------------------------------------------------ olay bağlama
function autosize() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
}

$('new-chat').addEventListener('click', newChat);
$('open-settings').addEventListener('click', openSettings);
$('settings-cancel').addEventListener('click', closeSettings);
// Modal arka planına tıklamak pencereyi kapatır; ekranın geri kalanı kilitli kalmaz.
$('modal').addEventListener('click', (event) => {
  if (event.target === $('modal')) closeSettings();
});
$('clear-key').addEventListener('click', async () => {
  if (!confirm('Kayıtlı API anahtarı silinsin mi?')) return;
  await applySettingsPatch({ clearApiKey: true });
  openSettings();
});
$('test-key')?.addEventListener('click', async () => {
  const typed = $('api-key').value.trim();
  const infoEl = $('key-info');
  infoEl.textContent = 'OpenRouter ile doğrulanıyor…';
  infoEl.style.color = '';
  try {
    const res = await window.api.checkApiKey(typed || null);
    if (res.ok) {
      const label = res.data.label ? ` ("${res.data.label}")` : '';
      const limit = res.data.limit != null ? ` | Limit: $${res.data.limit}` : '';
      const usage = res.data.usage != null ? ` | Harcanan: $${Number(res.data.usage).toFixed(3)}` : '';
      infoEl.textContent = `✅ Anahtar geçerli ve aktif${label}${limit}${usage}`;
      infoEl.style.color = '#10b981';
    } else {
      infoEl.textContent = `❌ Geçersiz anahtar: ${res.error}. Lütfen openrouter.ai/settings/keys adresinden yeni bir anahtar alıp buraya yapıştırın.`;
      infoEl.style.color = '#ef4444';
    }
  } catch (err) {
    infoEl.textContent = `❌ Test hatası: ${err.message}`;
    infoEl.style.color = '#ef4444';
  }
});
$('settings-save').addEventListener('click', async () => {
  const selectedMode = document.querySelector('input[name="perm-mode"]:checked')?.value || currentPermissionMode;
  const patch = {
    theme: $('theme').value,
    permissionMode: selectedMode,
    autoApprove: selectedMode === 'auto' || selectedMode === 'turbo',
    fallbackModel: $('fallback-model').value.trim(),
    subagentModel: $('subagent-model-setting') ? $('subagent-model-setting').value.trim() : undefined,
    maxSteps: $('max-steps').value,
    mdUpdateSteps: $('md-update-steps') ? $('md-update-steps').value : undefined,
    commandTimeout: $('cmd-timeout').value,
    temperature: $('temperature').value,
    budget: $('budget').value,
    maxContextTokens: $('max-context-tokens').value,
    subagentBudget: $('subagent-budget') ? $('subagent-budget').value : undefined,
    customPrompt: $('custom-prompt').value,
    sandbox: $('sandbox').checked,
    sandboxNetwork: $('sandbox-net').checked
  };
  const key = $('api-key').value.trim();
  if (key) {
    if (/\s/.test(key)) {
      alert('Hata: API anahtarı boşluk içeremez. Lütfen bir komut veya metin yerine doğrudan OpenRouter API anahtarınızı (sk-or-v1-...) yapıştırın.');
      return;
    }
    patch.apiKey = key;
  }
  await applySettingsPatch(patch);
  setPermissionMode(selectedMode, false);
  renderTopbar();
  closeSettings();
  loadModels();
});

// Modal içindeki izin seçici kartlarına tıklama
document.querySelectorAll('.perm-radio-card').forEach((card) => {
  card.addEventListener('click', () => {
    const radio = card.querySelector('input[type="radio"]');
    if (radio) {
      radio.checked = true;
      document.querySelectorAll('.perm-radio-card').forEach((c) => c.classList.toggle('active', c === card));
    }
  });
});

// Karşılama kartındaki hızlı komut düğmeleri
document.querySelectorAll('.cmd-pill').forEach((btn) => {
  btn.addEventListener('click', () => {
    const cmd = btn.dataset.cmd;
    if (cmd) runSlash(cmd);
  });
});

sendBtn.addEventListener('click', sendMessage);
inputEl.addEventListener('input', () => { autosize(); updateSlashHints(); });
inputEl.addEventListener('keydown', (e) => {
  const hintsOpen = !$('slash-hints').hidden;
  if (hintsOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    slashIndex += e.key === 'ArrowDown' ? 1 : -1;
    syncSlashActive();
    return;
  }
  if (hintsOpen && e.key === 'Escape') {
    e.preventDefault();
    hideSlashHints();
    return;
  }
  if (hintsOpen && e.key === 'Tab') {
    e.preventDefault();
    const activeBtn = $('slash-hints').querySelector('button.active') || $('slash-hints').querySelector('button');
    if (activeBtn) {
      const cmd = activeBtn.dataset.cmd;
      inputEl.value = cmd + (cmd === '/model' || cmd === '/mode' ? ' ' : '');
      hideSlashHints();
    }
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    // Giriş alanı boşken ve bekleyen bir onay kartı varsa Enter ile onayla
    if (pendingApproval && !inputEl.value.trim() && !hintsOpen) {
      pendingApproval.answer('allow');
      return;
    }
    if (hintsOpen) {
      const activeBtn = $('slash-hints').querySelector('button.active');
      if (activeBtn && inputEl.value.trim() !== activeBtn.dataset.cmd) {
        activeBtn.click();
        return;
      }
    }
    sendMessage();
  }
});
$('chat-search').addEventListener('input', (e) => { search = e.target.value; renderSidebar(); });

window.addEventListener('keydown', (e) => {
  const modalOpen = !$('modal').classList.contains('hidden');
  const changesOpen = $('changes-modal') && !$('changes-modal').classList.contains('hidden');
  const activeModal = changesOpen ? $('changes-modal') : (modalOpen ? $('modal') : null);
  if (activeModal && e.key === 'Tab') {
    const focusables = [...activeModal.querySelectorAll('input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled)')];
    if (focusables.length) {
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    return;
  }

  // Bekleyen onay kartı varsa Enter ile onayla (sadece mouse gerekmesin)
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing) {
    const t = e.target;
    const isTyping = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (!activeModal && !isTyping && pendingApproval && (!pendingApproval.card || pendingApproval.card.isConnected)) {
      e.preventDefault();
      pendingApproval.answer('allow');
      return;
    }
  }

  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape') {
    if (changesOpen) closeChangesModal();
    else if ($('subagent-menu') && !$('subagent-menu').hidden) closeSubagentMenu();
    else if ($('perm-menu') && !$('perm-menu').hidden) closePermMenu();
    else if ($('model-dropdown') && !$('model-dropdown').hidden) closeModelDropdown();
    else if (!$('export-menu').hidden) closeExportMenu();
    else if (modalOpen) closeSettings();
    else if (running.has(activeId)) window.api.stop(activeId);
  } else if (!activeModal && mod && e.key.toLowerCase() === 'n') { e.preventDefault(); newChat(); }
  else if (!activeModal && mod && e.key.toLowerCase() === 'k') { e.preventDefault(); $('chat-search').focus(); }
  else if (!changesOpen && mod && e.key === ',') { e.preventDefault(); openSettings(); }
});

function handleModelListKeydown(e) {
  const dd = $('model-dropdown');
  if (!dd || dd.hidden) return;
  const filtered = getFilteredModels();
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (filtered.length) {
      modelFocusIdx = (modelFocusIdx + 1) % filtered.length;
      renderModelDropdown();
      $('model-list')?.querySelector('.model-item.focused')?.scrollIntoView({ block: 'nearest' });
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (filtered.length) {
      modelFocusIdx = (modelFocusIdx - 1 + filtered.length) % filtered.length;
      renderModelDropdown();
      $('model-list')?.querySelector('.model-item.focused')?.scrollIntoView({ block: 'nearest' });
    }
  } else if (e.key === 'Enter') {
    if (modelFocusIdx >= 0 && filtered[modelFocusIdx]) {
      e.preventDefault();
      selectModel(filtered[modelFocusIdx].id);
    } else if (e.target === $('model-search') && filtered[0]) {
      e.preventDefault();
      selectModel(filtered[0].id);
    }
  }
}

modelInput.addEventListener('focus', () => {
  openModelDropdown();
});

modelInput.addEventListener('click', () => {
  openModelDropdown();
});

modelInput.addEventListener('input', () => {
  modelSearchQuery = modelInput.value;
  if ($('model-search')) $('model-search').value = modelInput.value;
  modelFocusIdx = 0;
  openModelDropdown();
});

modelInput.addEventListener('keydown', handleModelListKeydown);

modelInput.addEventListener('change', () => {
  const chat = active();
  const value = modelInput.value.trim();
  if (!chat || !value) return;
  chat.model = value;
  settings.defaultModel = value;
  saveChats();
  window.api.setSettings({ defaultModel: value });
});

$('model-toggle')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const dd = $('model-dropdown');
  if (!dd) return;
  if (dd.hidden) {
    openModelDropdown();
    $('model-search')?.focus();
  } else {
    closeModelDropdown();
  }
});

$('model-refresh')?.addEventListener('click', (e) => {
  e.stopPropagation();
  loadModels({ openAfter: true });
});

$('model-search')?.addEventListener('input', (e) => {
  modelSearchQuery = e.target.value;
  modelFocusIdx = 0;
  renderModelDropdown();
});

$('model-search')?.addEventListener('keydown', handleModelListKeydown);

$('model-family-filters')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.filter-chip');
  if (!btn) return;
  modelFilterFamily = btn.dataset.family || 'all';
  modelFocusIdx = 0;
  renderModelDropdown();
});

$('model-cap-filters')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.cap-chip[data-cap]');
  if (!btn) return;
  const cap = btn.dataset.cap;
  if (modelFilterCaps.has(cap)) modelFilterCaps.delete(cap);
  else modelFilterCaps.add(cap);
  modelFocusIdx = 0;
  renderModelDropdown();
});

function toggleWebSearch() {
  settings.webSearch = !settings.webSearch;
  window.api.setSettings({ webSearch: settings.webSearch });
  renderRuntimeOptions();
}

function setReasoningEffort(effort) {
  settings.reasoningEffort = effort || '';
  window.api.setSettings({ reasoningEffort: effort || null });
  renderRuntimeOptions();
}

$('opt-web')?.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleWebSearch();
});

$('web-toggle')?.addEventListener('click', () => {
  toggleWebSearch();
});

$('model-runtime-bar')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.reasoning-chip');
  if (!btn) return;
  e.stopPropagation();
  setReasoningEffort(btn.dataset.effort || '');
});

$('reasoning-toggle')?.addEventListener('click', () => {
  const cur = settings.reasoningEffort || '';
  const idx = REASONING_ORDER.indexOf(cur);
  const next = REASONING_ORDER[(idx + 1) % REASONING_ORDER.length];
  setReasoningEffort(next);
});

$('pick-folder').addEventListener('click', async () => {
  const chat = active();
  if (!chat) return;
  const dir = await window.api.pickFolder();
  if (!dir) return;
  chat.workspace = dir;
  settings.lastWorkspace = dir;
  saveChats();
  window.api.setSettings({ lastWorkspace: dir });
  renderTopbar();
});

$('plan-toggle').addEventListener('click', () => {
  const chat = active();
  if (!chat) return;
  chat.planMode = !chat.planMode;
  saveChats();
  renderTopbar();
  renderMessages();
});

// ------------------------------------------------------------------ Subagent (Alt Ajan) Aç/Kapa ve Model Seçici
async function selectSubagentModel(modelId) {
  const val = String(modelId || '').trim().replace(/:online$/i, '') || DEFAULT_SUBAGENT_MODEL;
  settings.subagentModel = val;
  await window.api.setSettings({ subagentModel: val });
  const chat = active();
  if (chat && chat.subagentEnabled === undefined) {
    chat.subagentEnabled = true;
    saveChats();
  }
  renderSubagentMenu();
  renderTopbar();
}

function renderSubagentMenu() {
  const presetsEl = $('subagent-presets');
  if (!presetsEl) return;
  presetsEl.replaceChildren();
  const curModel = getActiveSubagentModel();
  const isPreset = SUBAGENT_PRESETS.some((p) => p.id === curModel);

  const items = isPreset
    ? SUBAGENT_PRESETS
    : [{ id: curModel, icon: '✨', name: curModel, desc: 'Özel seçilen F/P alt ajan modeli' }, ...SUBAGENT_PRESETS];

  for (const p of items) {
    const btn = el('button', 'perm-option' + (p.id === curModel ? ' active' : ''));
    btn.type = 'button';
    btn.setAttribute('role', 'menuitem');
    const icon = el('span', 'perm-opt-icon', p.icon);
    const info = el('div', 'perm-opt-info');
    info.append(el('div', 'perm-opt-name', p.name), el('div', 'perm-opt-desc', p.desc));
    const check = el('span', 'perm-check', '✓');
    btn.append(icon, info, check);
    btn.addEventListener('click', async () => {
      await selectSubagentModel(p.id);
      const chat = active();
      if (chat && !isChatSubagentOn(chat)) {
        chat.subagentEnabled = true;
        saveChats();
        renderTopbar();
      }
      closeSubagentMenu();
    });
    presetsEl.appendChild(btn);
  }
}

function renderSubagentSearchResults(query) {
  const resultsEl = $('subagent-search-results');
  if (!resultsEl) return;
  const q = String(query || '').trim().toLowerCase();
  if (!q) {
    resultsEl.hidden = true;
    resultsEl.replaceChildren();
    return;
  }
  const matches = allModels
    .filter((m) => m.tools && (`${m.id} ${m.name}`).toLowerCase().includes(q))
    .slice(0, 15);
  resultsEl.replaceChildren();
  if (!matches.length) {
    resultsEl.hidden = true;
    return;
  }
  for (const m of matches) {
    const item = el('button', 'subagent-search-item');
    item.type = 'button';
    const priceText = m.free ? 'Ücretsiz' : (m.promptPrice != null ? `${formatPricePerM(m.promptPrice)}/1M` : '');
    item.append(el('span', null, m.id), el('span', 'sub-price', priceText));
    item.addEventListener('click', async () => {
      if ($('subagent-search')) $('subagent-search').value = '';
      resultsEl.hidden = true;
      await selectSubagentModel(m.id);
      const chat = active();
      if (chat && !isChatSubagentOn(chat)) {
        chat.subagentEnabled = true;
        saveChats();
        renderTopbar();
      }
      closeSubagentMenu();
    });
    resultsEl.appendChild(item);
  }
  resultsEl.hidden = false;
}

function closeSubagentMenu() {
  const menu = $('subagent-menu');
  if (menu) {
    menu.hidden = true;
    $('subagent-menu-btn')?.setAttribute('aria-expanded', 'false');
  }
}

function toggleSubagentMenu() {
  const menu = $('subagent-menu');
  if (!menu) return;
  const willShow = menu.hidden;
  if (willShow) {
    renderSubagentMenu();
    if ($('subagent-search')) $('subagent-search').value = '';
    renderSubagentSearchResults('');
  }
  menu.hidden = !willShow;
  $('subagent-menu-btn')?.setAttribute('aria-expanded', String(willShow));
}

$('subagent-toggle')?.addEventListener('click', () => {
  const chat = active();
  if (!chat) return;
  chat.subagentEnabled = !isChatSubagentOn(chat);
  saveChats();
  renderTopbar();
});

$('subagent-menu-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleSubagentMenu();
});

$('subagent-search')?.addEventListener('input', (e) => {
  renderSubagentSearchResults(e.target.value);
});

$('subagent-search')?.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const val = $('subagent-search').value.trim();
    if (val) {
      await selectSubagentModel(val);
      closeSubagentMenu();
    }
  }
});

$('subagent-apply-custom')?.addEventListener('click', async () => {
  const val = $('subagent-search')?.value.trim();
  if (!val) return;
  await selectSubagentModel(val);
  closeSubagentMenu();
});

$('undo-btn').addEventListener('click', async () => {
  const chat = active();
  if (!chat || running.has(chat.id)) return;
  const count = Number($('undo-btn').dataset.files || 0);
  const label = count > 0 ? `${count} dosyadaki değişiklik` : 'dosya değişiklikleri';
  if (!confirm(`Son çalışmada yapılan ${label} geri alınsın mı?`)) return;
  await doUndo(chat);
});

$('changes-btn')?.addEventListener('click', () => openChangesModal());
$('changes-close')?.addEventListener('click', closeChangesModal);
$('changes-modal')?.addEventListener('click', (e) => {
  if (e.target === $('changes-modal')) closeChangesModal();
});
$('changes-undo-all')?.addEventListener('click', async () => {
  const chat = active();
  if (!chat || running.has(chat.id)) return;
  if (!confirm('Bu oturumda değiştirilen tüm dosyalar geri alınsın mı?')) return;
  closeChangesModal();
  const r = await window.api.undoAll(chat.id);
  notice(chat, r.message);
  await updateUndo();
});

function closePermMenu() {
  const menu = $('perm-menu');
  if (menu) {
    menu.hidden = true;
    $('perm-btn')?.setAttribute('aria-expanded', 'false');
  }
}

function togglePermMenu() {
  const menu = $('perm-menu');
  if (!menu) return;
  const willShow = menu.hidden;
  menu.hidden = !willShow;
  $('perm-btn')?.setAttribute('aria-expanded', String(willShow));
}

$('perm-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  togglePermMenu();
});

$('perm-menu')?.addEventListener('click', (e) => {
  const opt = e.target.closest('.perm-option');
  if (!opt) return;
  const mode = opt.dataset.mode;
  if (mode) {
    setPermissionMode(mode, true);
    closePermMenu();
  }
});

function closeExportMenu() {
  $('export-menu').hidden = true;
  $('export-btn').setAttribute('aria-expanded', 'false');
}

$('export-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('export-menu');
  const nextHidden = !menu.hidden;
  menu.hidden = nextHidden;
  $('export-btn').setAttribute('aria-expanded', String(!nextHidden));
});

$('export-menu').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-ext]');
  if (!btn) return;
  const ext = btn.dataset.ext;
  closeExportMenu();
  if (ext === 'cancel') return;
  const chat = active();
  if (!chat) return;
  const asJson = ext === 'json';
  const content = asJson ? JSON.stringify(chat, null, 2) : exportMarkdown(chat);
  const savedPath = await window.api.exportChat({ title: chat.title, content, ext: asJson ? 'json' : 'md' });
  if (savedPath) notice(chat, `Sohbet kaydedildi: ${savedPath}`);
});

window.addEventListener('click', (e) => {
  if (!$('export-menu').hidden && !e.target.closest('.export-wrap')) closeExportMenu();
  if ($('model-dropdown') && !$('model-dropdown').hidden && !e.target.closest('#model-picker')) closeModelDropdown();
  if ($('perm-menu') && !$('perm-menu').hidden && !e.target.closest('.perm-picker-wrap')) closePermMenu();
  if ($('subagent-menu') && !$('subagent-menu').hidden && !e.target.closest('#subagent-picker')) closeSubagentMenu();
});

// ------------------------------------------------------------------ başlangıç
(async function init() {
  settings = await window.api.getSettings();
  sysInfo = await window.api.sysInfo();
  applyTheme();
  const initialPermMode = settings.permissionMode || (settings.autoApprove ? 'auto' : 'normal');
  setPermissionMode(initialPermMode, false);
  chats = await window.api.loadChats();
  if (chats.length) { activeId = chats[0].id; renderAll(); } else { newChat(); }
  if (!settings.hasApiKey) openSettings();
  loadModels();
})();
