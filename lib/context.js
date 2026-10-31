// Bağlam yönetimi: eski araç çıktılarını ve uzun argümanları kısaltır.
// Yalnızca API'ye giden kopya kısaltılır; kayıtlı sohbet geçmişi değişmez.

// Görsellerin base64 içeriği metin gibi sayılmasın (görsel başına yaklaşık 1000 token varsay).
const IMAGE_DATA_RE = /data:[\w/+.-]+;base64,[A-Za-z0-9+/=]+/g;
const IMAGE_TOKEN_ESTIMATE = 1000;
const estimateTokens = (messages) =>
  Math.ceil(JSON.stringify(messages).replace(IMAGE_DATA_RE, 'x'.repeat(IMAGE_TOKEN_ESTIMATE * 4)).length / 4);

function shortenString(s, limit) {
  return s.length > limit ? s.slice(0, limit) + `… [${s.length - limit} karakter kısaltıldı]` : s;
}

function compactArgs(argStr, limit) {
  if (!argStr || argStr.length <= limit) return argStr;
  try {
    const obj = JSON.parse(argStr);
    for (const k of Object.keys(obj)) {
      if (typeof obj[k] === 'string') obj[k] = shortenString(obj[k], Math.min(limit, 200));
      else if (Array.isArray(obj[k])) {
        const j = JSON.stringify(obj[k]);
        if (j.length > limit) obj[k] = shortenString(j, Math.min(limit, 200));
      }
    }
    return JSON.stringify(obj);
  } catch {
    return '{}';
  }
}

function compactHistory(messages, { keepRecent = 10, toolLimit = 1500, argLimit = 1000 } = {}) {
  const cutoff = messages.length - keepRecent;
  return messages.map((m, i) => {
    if (i >= cutoff) return m;
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > toolLimit) {
      return { ...m, content: shortenString(m.content, toolLimit) };
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      return {
        ...m,
        tool_calls: m.tool_calls.map((tc) => ({
          ...tc, function: { ...tc.function, arguments: compactArgs(tc.function.arguments, argLimit) }
        }))
      };
    }
    return m;
  });
}

// Base64 görsel parçalarını metin yer tutucusuyla değiştirir. Eski görseller hiç
// atılmadığı için her turda yeniden gönderiliyordu; bu, bağlam maliyetini sürekli büyütür.
const isImagePart = (p) => p && p.type === 'image_url';
const imagePlaceholder = (kept) => ({ type: 'text', text: kept ? '[görsel]' : '[görsel: bağlamdan çıkarıldı]' });
const isFilePart = (p) => p && p.type === 'file' && typeof p.file?.file_data === 'string';
const filePlaceholder = (p) => ({ type: 'text', text: `[PDF: ${p.file?.filename || 'ek'} bağlamdan çıkarıldı]` });

function dropOldImages(messages, keepRecent = 2) {
  const userImageIdx = [];
  messages.forEach((m, i) => {
    if (m.role === 'user' && Array.isArray(m.content) && m.content.some(isImagePart)) userImageIdx.push(i);
  });
  if (userImageIdx.length <= keepRecent) return messages;
  const keepFrom = userImageIdx[userImageIdx.length - keepRecent];
  let changed = false;
  const out = messages.map((m, i) => {
    if (i >= keepFrom) return m;
    if (m.role !== 'user' || !Array.isArray(m.content) || !m.content.some(isImagePart)) return m;
    changed = true;
    return { ...m, content: m.content.map((p) => (isImagePart(p) ? imagePlaceholder(false) : p)) };
  });
  return changed ? out : messages;
}

function dropOldFiles(messages, keepRecent = 1) {
  const fileIdx = [];
  messages.forEach((m, i) => {
    if (m.role === 'user' && Array.isArray(m.content) && m.content.some(isFilePart)) fileIdx.push(i);
  });
  if (fileIdx.length <= keepRecent) return messages;
  const keepFrom = keepRecent > 0 ? fileIdx[fileIdx.length - keepRecent] : Infinity;
  let changed = false;
  const out = messages.map((m, i) => {
    if (i >= keepFrom || m.role !== 'user' || !Array.isArray(m.content) || !m.content.some(isFilePart)) return m;
    changed = true;
    return { ...m, content: m.content.flatMap((p) => isFilePart(p) ? [filePlaceholder(p)] : [p]) };
  });
  return changed ? out : messages;
}

// Kademeli kısaltma: önce hafif, sığmazsa daha agresif.
function fitHistory(messages, maxTokens = 150000) {
  const levels = [
    null,
    { keepRecent: 10, toolLimit: 1500, argLimit: 1000 },
    { keepRecent: 6, toolLimit: 500, argLimit: 300 },
    { keepRecent: 3, toolLimit: 200, argLimit: 150 }
  ];
  let out = messages;
  for (const lv of levels) {
    out = lv ? compactHistory(messages, lv) : messages;
    if (estimateTokens(out) <= maxTokens) return out;
  }
  return out;
}

// Fit the complete request, including the system prompt and tool schemas. Keep
// room for the model's reply because provider context limits include output.
function fitRequestContext(messages, maxTokens = 150000, { system = null, tools = [] } = {}) {
  const budget = Math.floor(maxTokens * 0.9);
  const fixed = { system, tools };
  const levels = [
    null,
    { keepRecent: 10, toolLimit: 1500, argLimit: 1000 },
    { keepRecent: 6, toolLimit: 500, argLimit: 300 },
    { keepRecent: 3, toolLimit: 200, argLimit: 150 },
    { keepRecent: 0, toolLimit: 200, argLimit: 100 }
  ];
  const imageKeeps = [2, 1, 0];
  for (const fileKeep of [1, 0]) {
    for (const keep of imageKeeps) {
      const withoutOldAttachments = dropOldFiles(dropOldImages(messages, keep), fileKeep);
      for (const level of levels) {
        const candidate = level ? compactHistory(withoutOldAttachments, level) : withoutOldAttachments;
        if (estimateTokens({ ...fixed, messages: candidate }) <= budget) return candidate;
      }
    }
  }
  throw new Error(`İstek, ayarlanan yaklaşık bağlam bütçesine (${maxTokens.toLocaleString()} token) sığmıyor. Eski sohbeti /compact ile kısalt veya bağlam limitini artır.`);
}

// Her tool_call için bir "tool" yanıtı olmasını sağlar (yarım kalan çalışmalardan sonra API hata vermesin).
function repairToolPairs(messages) {
  const answered = new Set(messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
  const out = [];
  for (const m of messages) {
    out.push(m);
    if (m.role === 'assistant' && m.tool_calls?.length) {
      for (const tc of m.tool_calls) {
        if (!answered.has(tc.id)) out.push({ role: 'tool', tool_call_id: tc.id, content: 'Bu araç çağrısı tamamlanmadı (çalışma kesildi).' });
      }
    }
  }
  return out;
}

// Çok turlu akıl yürütme sağlayıcılarında kaliteyi korumak için reasoning geri gönderilmeli,
// ancak her sağlayıcı bunu kabul etmiyor (ör. DeepSeek ham reasoning metnini reddediyor) ve
// Anthropic yalnızca imzalı blokları kabul ediyor. Bu yüzden yalnızca sağlayıcının kendi
// döndürdüğü yapılandırılmış `reasoning_details` aynen geri gönderilir; ham metinden
// reasoning uydurulmaz.
function reasoningDetailsOf(m) {
  const details = m?.reasoning_details;
  return Array.isArray(details) && details.length ? details : null;
}

// API'ye gidecek kopya: arayüze özel alanları, boş asistan mesajlarını ve yetim (orphan) tool yanıtlarını çıkarır.
// "notice" mesajları yalnızca arayüz içindir; forModel:true olanlar modele kullanıcı notu olarak gider.
function prepareForApi(messages, { keepReasoning = true } = {}) {
  const declaredToolCalls = new Set();
  const keepDetails = keepReasoning;
  const cleaned = messages
    .map((m) => (m.role === 'notice' ? (m.forModel ? { role: 'user', content: `[Sistem notu] ${m.content}` } : null) : (m.role === 'changes_summary' ? null : m)))
    .filter((m) => m && !(m.role === 'assistant' && !m.content && !m.tool_calls?.length))
    .map((m) => {
      if (m.role !== 'assistant') return m;
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) if (tc?.id) declaredToolCalls.add(tc.id);
      }
      const { reasoning, reasoning_details: details, truncated, ...rest } = m; // eslint-disable-line no-unused-vars
      const keep = keepDetails ? reasoningDetailsOf(m) : null;
      return keep ? { ...rest, reasoning_details: keep } : rest;
    });
  return cleaned.filter((m) => m.role !== 'tool' || (m.tool_call_id && declaredToolCalls.has(m.tool_call_id)));
}

module.exports = {
  estimateTokens, compactHistory, fitHistory, fitRequestContext, repairToolPairs, prepareForApi,
  dropOldImages, dropOldFiles, IMAGE_TOKEN_ESTIMATE
};
