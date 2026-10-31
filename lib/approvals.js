// Onay ve soru yönetimi: araçlar kullanıcıya soru sorabilir, kullanıcı arayüzden yanıt verir.
// Kademeli izin modları: Sıkı (strict), Normal (normal), Oto (auto), Turbo (turbo).
const crypto = require('crypto');

const VALID_PERMISSION_MODES = new Set(['strict', 'normal', 'auto', 'turbo']);

function resolvePermissionMode(settings = {}, overrideMode = null) {
  if (overrideMode && VALID_PERMISSION_MODES.has(overrideMode)) return overrideMode;
  if (settings && settings.permissionMode && VALID_PERMISSION_MODES.has(settings.permissionMode)) return settings.permissionMode;
  if (settings && settings.autoApprove) return 'auto';
  return 'normal';
}

function createApprovals() {
  const pending = new Map(); // id -> { type, resolve }
  const sessions = new Map(); // chatId -> Set(anahtar)

  const sessionOf = (chatId) => {
    if (!sessions.has(chatId)) sessions.set(chatId, new Set());
    return sessions.get(chatId);
  };

  function wait(type, id, signal, onAbortValue) {
    return new Promise((resolve) => {
      if (signal.aborted) { resolve(onAbortValue); return; }
      const onAbort = () => { if (pending.delete(id)) resolve(onAbortValue); };
      // Yanıt gelince dinleyici de kaldırılır; yoksa uzun çalışmada abort sinyaline birikir.
      pending.set(id, { type, resolve: (v) => { signal.removeEventListener('abort', onAbort); resolve(v); } });
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // Kademeli izin yönetimi:
  // - turbo: tüm kodlara ve komutlara sormadan izin verir
  // - auto: kendin karar ver; güvenli işlemleri otomatik onaylar, risklileri sorar
  // - normal: güvenli komutları hatırlar, riskli kodlarda mutlaka uyarır ve onay ister
  // - strict: her komudu sorar, oturum izniyle atlamaz
  async function approve({
    send, ac, settings, chatId, title, detail,
    format = 'text', force = false, warning = null,
    sessionKey = null, sessionLabel = null, permissionMode = null
  }) {
    const session = sessionOf(chatId);
    const mode = resolvePermissionMode(settings, permissionMode);

    // Turbo modu: tüm kodlara doğrudan izin ver
    if (mode === 'turbo') return true;

    // Oto modu: güvenli işlemleri kendin onayla; riskli/hassas işlemlerde kullanıcıya sor
    if (mode === 'auto') {
      if (!force && !warning) return true;
    }

    // Normal mod: riskli kodlarda mutlaka uyar; güvenli işlemlerde oturum iznini kontrol et
    if (mode === 'normal') {
      if (!force && !warning && sessionKey && session.has(sessionKey)) return true;
      if (!force && !warning && settings?.autoApprove) return true;
    }

    // Sıkı mod: her komudu sor (oturum izni sunulmaz / atlanmaz)
    const canOfferSession = mode === 'normal' && !force && !warning && !!sessionKey;
    const id = crypto.randomUUID();
    send('approval', {
      id,
      title,
      detail,
      format,
      warning,
      mode,
      sessionLabel: canOfferSession ? sessionLabel : null
    });

    const decision = await wait('approval', id, ac.signal, 'deny');
    if (decision === 'allow_session' && canOfferSession) {
      session.add(sessionKey);
      return true;
    }
    // force=true veya canOfferSession=false ise allow_session geçersizdir, allow gerekir
    return decision === 'allow' || (decision === 'allow_session' && canOfferSession);
  }

  async function ask({ send, ac, question, options }) {
    const id = crypto.randomUUID();
    send('question', { id, question, options });
    return wait('question', id, ac.signal, null);
  }

  function respond(id, payload) {
    const p = pending.get(id);
    if (!p) return false;
    pending.delete(id);
    if (p.type === 'approval') p.resolve(['allow', 'allow_session', 'deny'].includes(payload) ? payload : 'deny');
    else p.resolve(typeof payload === 'string' ? payload.slice(0, 10000) : null);
    return true;
  }

  const clearSession = (chatId) => sessions.delete(chatId);

  return { approve, ask, respond, clearSession };
}

module.exports = { createApprovals, resolvePermissionMode, VALID_PERMISSION_MODES };
