// Bağlam yönetimi: eski araç çıktılarını ve uzun argümanları kısaltır.
// Yalnızca API'ye giden kopya kısaltılır; kayıtlı sohbet geçmişi değişmez.

// Görsellerin base64 içeriği metin gibi sayılmasın (görsel başına yaklaşık 1000 token varsay).
const estimateTokens = (messages) =>
  Math.ceil(JSON.stringify(messages).replace(/data:[\w/+.-]+;base64,[A-Za-z0-9+/=]+/g, 'x'.repeat(4000)).length / 4);

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

// API'ye gidecek kopya: arayüze özel alanları, boş asistan mesajlarını ve yetim (orphan) tool yanıtlarını çıkarır.
// "notice" mesajları yalnızca arayüz içindir; forModel:true olanlar modele kullanıcı notu olarak gider.
function prepareForApi(messages) {
  const declaredToolCalls = new Set();
  const cleaned = messages
    .map((m) => (m.role === 'notice' ? (m.forModel ? { role: 'user', content: `[Sistem notu] ${m.content}` } : null) : m))
    .filter((m) => m && !(m.role === 'assistant' && !m.content && !m.tool_calls?.length))
    .map((m) => {
      if (m.role !== 'assistant') return m;
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) if (tc?.id) declaredToolCalls.add(tc.id);
      }
      const { reasoning, ...rest } = m; // eslint-disable-line no-unused-vars
      return rest;
    });
  return cleaned.filter((m) => m.role !== 'tool' || (m.tool_call_id && declaredToolCalls.has(m.tool_call_id)));
}

module.exports = { estimateTokens, compactHistory, fitHistory, repairToolPairs, prepareForApi };
