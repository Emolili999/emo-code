// Ek dosya deposu: görseller chats.json içine base64 olarak gömülmez.
// Sohbet kaydında yalnızca küçük bir referans tutulur; içerik ayrı dosyada saklanır.
// Böylece her saveChats çağrısı tüm sohbet dosyasını yeniden yazmaz.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const DATA_URL_RE = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/;
const PDF_DATA_URL_RE = /^data:application\/pdf;base64,([A-Za-z0-9+/=]+)$/;
const REF_RE = /^att-[a-f0-9]{32}$/;
const REF_NAME_RE = /^att-[a-f0-9]{32}\.(png|jpeg|gif|webp|pdf)$/;

const EXT_FOR_MIME = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf' };

function createAttachments(baseDir) {
  const ensureDir = () => {
    fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
    return baseDir;
  };

  // data URL -> { ref, mime, size }. Aynı içerik aynı referansa düşer (yinelenen dosya yok).
  function save(dataUrl, mimeHint) {
    const value = String(dataUrl || '').trim();
    const image = DATA_URL_RE.exec(value);
    const pdf = PDF_DATA_URL_RE.exec(value);
    if (!image && !pdf) throw new Error('Yalnızca PNG/JPEG/GIF/WebP/PDF data URL eklenebilir.');
    const mime = pdf ? 'application/pdf' : (mimeHint && EXT_FOR_MIME[mimeHint] && mimeHint.startsWith('image/') ? mimeHint : image[1]);
    const buf = Buffer.from(pdf ? pdf[1] : image[2], 'base64');
    if (!buf.length) throw new Error('Ek dosya boş.');
    if (buf.length > MAX_ATTACHMENT_BYTES) throw new Error(`Ek dosya çok büyük (${(buf.length / 1048576).toFixed(1)} MB).`);
    const hash = crypto.createHash('sha256').update(mime).update(buf).digest('hex').slice(0, 32);
    const ref = `att-${hash}`;
    const file = path.join(ensureDir(), `${ref}.${EXT_FOR_MIME[mime]}`);
    if (!fs.existsSync(file)) {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, buf, { mode: 0o600 });
      fs.renameSync(tmp, file);
    }
    return { ref, mime, size: buf.length };
  }

  function fileFor(ref) {
    if (!REF_RE.test(String(ref || ''))) throw new Error('Geçersiz ek referansı.');
    for (const ext of new Set(Object.values(EXT_FOR_MIME))) {
      const f = path.join(baseDir, `${ref}.${ext}`);
      if (fs.existsSync(f)) return f;
    }
    throw new Error(`Ek bulunamadı: ${ref}`);
  }

  function readAsDataUrl(ref) {
    const file = fileFor(ref);
    const ext = path.extname(file).slice(1);
    const mime = Object.keys(EXT_FOR_MIME).find((k) => EXT_FOR_MIME[k] === ext) || 'image/png';
    return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
  }

  // Sohbet mesajlarındaki ek referanslarını API'nin beklediği content parts haline getirir.
  function resolveForApi(messages) {
    return messages.map((m) => {
      if (!Array.isArray(m.content)) return m;
      if (!m.content.some((p) => p?.type === 'image_ref' || p?.type === 'file_ref')) return m;
      const content = [];
      for (const p of m.content) {
        if (p?.type === 'image_ref') {
          try { content.push({ type: 'image_url', image_url: { url: readAsDataUrl(p.ref) } }); } catch { /* eksik ek: atla */ }
        } else if (p?.type === 'file_ref') {
          try { content.push({ type: 'file', file: { filename: p.filename || 'attachment.pdf', file_data: readAsDataUrl(p.ref) } }); } catch { /* eksik ek: atla */ }
        } else {
          content.push(p);
        }
      }
      return { ...m, content };
    });
  }

  // Kullanılmayan ekleri siler (sohbet silindiğinde çağrılır).
  function removeMany(refs) {
    let removed = 0;
    for (const ref of refs || []) {
      if (!REF_RE.test(String(ref || ''))) continue;
      for (const ext of new Set(Object.values(EXT_FOR_MIME))) {
        const f = path.join(baseDir, `${ref}.${ext}`);
        try { fs.rmSync(f, { force: true }); removed++; } catch { /* yok */ }
      }
    }
    return removed;
  }

  return { save, readAsDataUrl, resolveForApi, removeMany };
}

module.exports = { createAttachments, DATA_URL_RE, REF_RE, REF_NAME_RE, EXT_FOR_MIME, MAX_ATTACHMENT_BYTES };
