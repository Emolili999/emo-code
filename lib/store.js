// Dayanıklı JSON okuma/yazma ve atomik dosya yazma.
const fs = require('fs');
const path = require('path');

// Ana dosya bozuksa (veya yoksa) .bak yedeğine düşer.
function readJSON(file, fallback) {
  for (const f of [file, file + '.bak']) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* sıradakini dene */ }
  }
  return fallback;
}

// Önce geçici dosyaya yazar, sonra yeniden adlandırır: çökme durumunda yarım dosya kalmaz.
function writeJSON(file, data, { backup = false, pretty = true } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data), { mode: 0o600 });
  if (backup) {
    try { JSON.parse(fs.readFileSync(file, 'utf8')); fs.copyFileSync(file, file + '.bak'); } catch { /* sağlam dosya yok */ }
  }
  fs.renameSync(tmp, file);
}

// Kullanıcı dosyaları için atomik yazma: izinleri korur, symlink'in hedefine yazar.
function atomicWrite(file, content) {
  let target = file;
  let mode = 0o644;
  try {
    target = fs.realpathSync(file);
    mode = fs.statSync(target).mode & 0o777;
  } catch { /* yeni dosya */ }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', mode });
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* yok */ }
    throw e;
  }
}

// Buffer içeriklerini UTF-8 dönüşümüne uğratmadan atomik yazar (binary yedekler).
function atomicWriteBuffer(file, content, { mode: explicitMode } = {}) {
  if (!Buffer.isBuffer(content) && !(content instanceof Uint8Array)) {
    throw new TypeError('atomicWriteBuffer için Buffer veya Uint8Array gerekli.');
  }
  let target = file;
  let mode = explicitMode ?? 0o644;
  try {
    target = fs.realpathSync(file);
    if (explicitMode === undefined) mode = fs.statSync(target).mode & 0o777;
  } catch { /* yeni dosya */ }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, content, { mode });
    fs.renameSync(tmp, target);
    if (explicitMode !== undefined) fs.chmodSync(target, explicitMode & 0o777);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* yok */ }
    throw e;
  }
}

module.exports = { readJSON, writeJSON, atomicWrite, atomicWriteBuffer };
