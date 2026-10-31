// OpenRouter istemcisi: akışlı yanıt, yeniden deneme (429/5xx), yedek model ve kullanım bilgisi.
const URL_CHAT = 'https://openrouter.ai/api/v1/chat/completions';
const RETRY_STATUS = [408, 429, 500, 502, 503, 504];
const MAX_RETRIES = 3;

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(Object.assign(new Error('Durduruldu'), { name: 'AbortError' }));
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(Object.assign(new Error('Durduruldu'), { name: 'AbortError' })); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function errorMessage(status, text) {
  try {
    const j = JSON.parse(text);
    const m = j.error?.message || j.message;
    if (m) {
      if (status === 401) {
        return `OpenRouter 401: Geçersiz veya eksik API Anahtarı (${m}). Lütfen Ayarlar'dan (Ctrl+,) OpenRouter API anahtarınızı (sk-or-v1-...) kontrol edin.`;
      }
      return `OpenRouter ${status}: ${m}`;
    }
  } catch { /* düz metin */ }
  return `OpenRouter ${status}: ${text.slice(0, 500)}`;
}

async function streamCompletion({
  apiKey, model, fallbackModel, messages, tools, temperature, webSearch, reasoningEffort, ac, send,
  maxTokens, endpoint = URL_CHAT
}) {
  const applyOnline = (m) => (webSearch && m && !String(m).endsWith(':online') ? `${m}:online` : m);
  const primaryModel = applyOnline(model);
  const backupModel = fallbackModel ? applyOnline(fallbackModel) : '';
  const body = { messages, stream: true, usage: { include: true } };
  // Yanıt uzunluğuna üst sınır koy: kaçak/tekrarlı bir üretim tek istekte bütçeyi ve
  // bağlamı patlatmasın. Sınır, modelin bağlamına göre main.js'te hesaplanır.
  const cap = Number(maxTokens);
  if (Number.isFinite(cap) && cap > 0) body.max_tokens = Math.max(1, Math.round(cap));
  if (Array.isArray(tools) && tools.length) body.tools = tools;
  if (backupModel && backupModel !== primaryModel) body.models = [primaryModel, backupModel]; else body.model = primaryModel;
  if (Number.isFinite(temperature)) body.temperature = temperature;
  if (reasoningEffort === 'none') {
    body.reasoning = { enabled: false };
  } else if (['low', 'medium', 'high'].includes(reasoningEffort)) {
    body.reasoning = { effort: reasoningEffort };
  }

  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        signal: ac.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost',
          'X-Title': 'emo-code'
        },
        body: JSON.stringify(body)
      });
    } catch (e) {
      if (e.name === 'AbortError' || ac.signal.aborted || attempt >= MAX_RETRIES) throw e;
      const wait = 1000 * 2 ** attempt;
      send('status', { text: `Bağlantı hatası, ${Math.round(wait / 1000)} sn sonra yeniden denenecek (${attempt + 1}/${MAX_RETRIES})…` });
      await sleep(wait, ac.signal);
      continue;
    }
    if (res.ok) break;
    const text = await res.text().catch(() => '');
    if (res.status === 400 && body.reasoning) {
      delete body.reasoning;
      continue;
    }
    if (!RETRY_STATUS.includes(res.status) || attempt >= MAX_RETRIES) throw new Error(errorMessage(res.status, text));
    const ra = Number(res.headers.get('retry-after'));
    const wait = Math.min(30000, ra > 0 ? ra * 1000 : 1000 * 2 ** attempt);
    send('status', { text: `OpenRouter ${res.status}: ${Math.round(wait / 1000)} sn sonra yeniden denenecek (${attempt + 1}/${MAX_RETRIES})…` });
    await sleep(wait, ac.signal);
  }
  send('status', { text: '' });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let reasoning = '';
  let toolCalls = [];
  let usage = null;
  let aborted = false;
  let finishReason = '';
  let reasoningDetails = null;

  const processLine = (rawLine) => {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) return; // ": OPENROUTER PROCESSING" gibi yorumları atla
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let json;
    try { json = JSON.parse(data); } catch { return; }
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    if (json.usage) {
      usage = {
        prompt: json.usage.prompt_tokens || 0,
        completion: json.usage.completion_tokens || 0,
        cost: Number(json.usage.cost) || 0
      };
    }
    const choice = json.choices?.[0];
    if (choice?.finish_reason) finishReason = String(choice.finish_reason);
    const delta = choice?.delta;
    if (!delta) return;
    const thought = typeof delta.reasoning === 'string'
      ? delta.reasoning
      : (typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '');
    if (thought) {
      reasoning += thought;
      send('reasoning', { text: thought });
    }
    // Sağlayıcının imzalı/artalanlı düşünce blokları: çok turlu akıl yürütme için aynen saklanır.
    if (Array.isArray(json.choices?.[0]?.message?.reasoning_details)) {
      reasoningDetails = json.choices[0].message.reasoning_details;
    } else if (Array.isArray(delta.reasoning_details)) {
      reasoningDetails = (reasoningDetails || []).concat(delta.reasoning_details);
    }
    if (delta.content) {
      content += delta.content;
      send('delta', { text: delta.content });
    }
    if (delta.tool_calls) {
      for (const t of delta.tool_calls) {
        const i = t.index ?? 0;
        toolCalls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (t.id) toolCalls[i].id = t.id;
        if (t.function?.name) toolCalls[i].function.name += t.function.name;
        if (t.function?.arguments) toolCalls[i].function.arguments += t.function.arguments;
      }
    }
  };

  try {
    while (true) {
      if (ac.signal.aborted) { aborted = true; break; }
      let packet;
      try {
        packet = await reader.read();
      } catch (e) {
        if (ac.signal.aborted || e.name === 'AbortError') { aborted = true; break; }
        throw e;
      }
      const { done, value } = packet;
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        processLine(line);
      }
    }
    buf += decoder.decode();
    if (buf.trim()) processLine(buf);
  } finally {
    if (aborted || ac.signal.aborted) {
      try { await reader.cancel(); } catch { /* akış zaten kapanmış olabilir */ }
    }
  }

  const wasAborted = aborted || ac.signal.aborted;
  const truncated = finishReason === 'length';
  const msg = { role: 'assistant', content };
  // Reasoning, çok turlu akıl yürütme sağlayıcılarında kaliteyi korumak için saklanır;
  // API'ye geri gönderilip gönderilmeyeceğine context.prepareForApi karar verir.
  if (reasoning) msg.reasoning = reasoning;
  if (reasoningDetails) msg.reasoning_details = reasoningDetails;
  if (truncated) msg.truncated = true;
  // İptal sırasında kısmi araç argümanları geçersiz olabilir; yalnızca metni koru.
  // max_tokens sınırına takılan yanıtta da araç argümanları yarım kalır: çalıştırma.
  if (!wasAborted && !truncated) {
    toolCalls = toolCalls.filter(Boolean);
    toolCalls.forEach((tc, i) => { if (!tc.id) tc.id = `call_${Date.now()}_${i}`; });
    if (toolCalls.length) msg.tool_calls = toolCalls;
  }
  if (truncated) {
    const kept = toolCalls.filter(Boolean).length;
    if (kept) msg.droppedToolCalls = kept;
  }
  return { msg, usage, aborted: wasAborted, finishReason, truncated };
}

// Akışsız tek seferlik çağrı (sohbet özetleme ve EMO.md ilerleme güncellemesi için).
async function complete({ apiKey, model, fallbackModel, messages, ac, maxTokens, endpoint = URL_CHAT }) {
  const body = { messages, usage: { include: true } };
  const cap = Number(maxTokens);
  if (Number.isFinite(cap) && cap > 0) body.max_tokens = Math.max(1, Math.round(cap));
  if (fallbackModel && fallbackModel !== model) body.models = [model, fallbackModel]; else body.model = model;
  let res;
  let text = '';
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(endpoint, {
        method: 'POST', signal: ac?.signal,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'http://localhost', 'X-Title': 'emo-code' },
        body: JSON.stringify(body)
      });
    } catch (e) {
      if (e.name === 'AbortError' || ac?.signal?.aborted || attempt >= MAX_RETRIES) throw e;
      await sleep(1000 * 2 ** attempt, ac.signal);
      continue;
    }
    text = await res.text().catch(() => '');
    if (res.ok) break;
    if (!RETRY_STATUS.includes(res.status) || attempt >= MAX_RETRIES || !ac?.signal) {
      throw new Error(errorMessage(res.status, text));
    }
    const ra = Number(res.headers.get('retry-after'));
    const wait = Math.min(30000, ra > 0 ? ra * 1000 : 1000 * 2 ** attempt);
    await sleep(wait, ac.signal);
  }
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('OpenRouter geçersiz JSON yanıtı döndürdü.'); }
  if (json.error) throw new Error(json.error.message || 'OpenRouter hatası');
  return { text: json.choices?.[0]?.message?.content || '', cost: Number(json.usage?.cost) || 0, prompt: json.usage?.prompt_tokens || 0, completion: json.usage?.completion_tokens || 0 };
}

module.exports = { streamCompletion, complete };
