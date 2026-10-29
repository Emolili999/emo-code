// Güvenlik kontrolleri: klasör, dosya, yol ve komut doğrulama.
// Bu modül Electron'a bağlı değildir; bu yüzden birim testi yazılabilir.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SYSTEM_DIRS = ['/etc', '/usr', '/var', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/root', '/proc', '/sys', '/dev', '/home'];
const SECRET_HOME_DIRS = ['.ssh', '.aws', '.gnupg', '.kube', '.config', '.local', '.mozilla', '.pki'];
const BROAD_HOME_DIRS = ['Documents', 'Belgeler', 'Downloads', 'İndirilenler', 'Desktop', 'Masaüstü', 'Pictures', 'Resimler'];

// "block": seçilemez, "warn": kullanıcıya sorulur, null: sorun yok
function checkWorkspace(dir, homeDir = os.homedir()) {
  let real;
  try { real = fs.realpathSync(dir); } catch { return { level: 'block', reason: 'Klasör bulunamadı.' }; }
  const home = fs.realpathSync(homeDir);
  if (real === '/' || path.parse(real).root === real) return { level: 'block', reason: 'Kök dizin (/) çalışma klasörü olamaz.' };
  if (real === home) return { level: 'block', reason: 'Ev dizininin tamamı çalışma klasörü olamaz. Belirli bir proje klasörünü seç.' };
  if (home.startsWith(real + path.sep)) return { level: 'block', reason: 'Ev dizinini kapsayan bir klasör seçilemez.' };
  if (SYSTEM_DIRS.some((d) => real === d || real.startsWith(d + path.sep)) && !real.startsWith(home + path.sep)) {
    return { level: 'block', reason: 'Sistem klasörleri çalışma klasörü olarak seçilemez.' };
  }
  const rel = path.relative(home, real);
  const first = rel.split(path.sep)[0];
  if (!rel.startsWith('..') && SECRET_HOME_DIRS.includes(first)) {
    return { level: 'block', reason: `~/${first} gizli ayarlar veya anahtarlar içerebilir; çalışma klasörü olarak seçilemez.` };
  }
  if (!rel.startsWith('..') && rel === first && BROAD_HOME_DIRS.includes(first)) {
    return { level: 'warn', reason: `"${first}" klasörü çok sayıda kişisel dosya içerebilir. Model bu klasördeki her dosyayı okuyabilir.` };
  }
  return null;
}

// Bu dosyalar modele asla gönderilmez (özel anahtarlar vb.)
const BLOCKED_DIRS = ['.ssh', '.aws', '.gnupg', '.kube', '.docker'];
const BLOCKED_NAME = /^(id_(rsa|dsa|ecdsa|ed25519)|.*\.(pem|key|p12|pfx|ppk|kdbx|keystore|jks)|\.netrc|\.pgpass|\.git-credentials)$/i;
// Bu dosyalar için her seferinde onay istenir ("sormadan onayla" açık olsa bile)
const ASK_NAME = /^(\.npmrc|\.pypirc|credentials.*|secrets?\..*|.*\.secrets?|service-account.*\.json|.*\.tfvars|terraform\.tfstate|wp-config\.php)$/i;

// 'block' | 'ask' | null
function classifyFile(root, full) {
  const candidates = [full];
  try { candidates.push(fs.realpathSync(full)); } catch { /* dosya henüz yok */ }
  let result = null;
  for (const c of candidates) {
    const rel = path.relative(root, c);
    const parts = rel.split(path.sep);
    const base = parts[parts.length - 1];
    if (parts.some((p) => BLOCKED_DIRS.includes(p)) || BLOCKED_NAME.test(base)) return 'block';
    const isEnv = /^\.env(\..+)?$/i.test(base) && !/\.(example|sample|template|dist)$/i.test(base);
    if (isEnv || ASK_NAME.test(base) || (parts.includes('.git') && base === 'config')) result = 'ask';
  }
  return result;
}

const SENSITIVE_CMD = /(\.ssh|\.aws|\.gnupg|\.kube|\.docker|id_(rsa|dsa|ecdsa|ed25519)|\.Add-MpPreference|\.(pem|key|p12|pfx|ppk|kdbx|keystore|jks|tfvars)\b|\.env\b|\.netrc|\.pgpass|\.npmrc|\.pypirc|\.git-credentials|\.git\/(config|hooks)|terraform\.tfstate|wp-config\.php|service-account|\/etc\/(shadow|passwd|sudoers)|credentials|secrets?\.)/i;
const RISKY_CMD = /(\bsudo\b|\bsu\b|\bpkexec\b|\bdoas\b|\brm\s+(-[a-z]*r[a-z]*\s+-[a-z]*f|\s*-[a-z]*f[a-z]*\s+-[a-z]*r|-[a-z]*(rf|fr)|--no-preserve-root)|\bfind\b.*\s-(delete|exec|execdir)\b|\bmkfs|\bdd\s+if=|\bchmod\s+-R|\bchown\s+-R|\|\s*(ba|z|da|k)?sh\b|\b(ba|z|da|k)?sh\s+-c\b|\b(curl|wget|nc|ncat|netcat|socat|telnet|scp|sftp|ftp|ssh|rsync)\b|\/dev\/(tcp|udp)\/|\beval\b|\bbase64\s+(-d|--decode)|\bgit\s+(push|remote|config)\b|\b(node|python3?|perl|ruby|php|lua)\s+(-e|-c|-r|-p|--eval|--print)\b|\bawk\b.*\bsystem\s*\(|\$\(|\`<|\`|\$\{?HOME\}?|~[a-z0-9_-]*\/|\.\.\/)/i;

function commandWarning(cmd) {
  if (SENSITIVE_CMD.test(cmd)) return 'Bu komut hassas dosyalara (anahtar, şifre, .env) erişiyor olabilir.';
  if (RISKY_CMD.test(cmd)) return 'Bu komut riskli olabilir: sistem değişikliği, ağ erişimi, kod çözme/çalıştırma veya çalışma klasörünün dışına çıkma içeriyor.';
  return null;
}

function resolveSafe(workspace, p) {
  if (!workspace) throw new Error('Çalışma klasörü seçilmedi.');
  const root = fs.realpathSync(workspace);
  const full = path.resolve(root, p || '.');
  // En yakın var olan üst dizinin gerçek yolunu kontrol et (symlink ile kaçışı önler)
  let probe = full;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const rel = path.relative(root, fs.realpathSync(probe));
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`Yol çalışma klasörünün dışında: ${p}`);
  }
  return { root, full };
}

const MAX_FILE_BYTES = 5 * 1024 * 1024;

// Boyut sınırı ve ikili (binary) dosya kontrolüyle metin dosyası okur.
function readTextFileSafe(file, maxBytes = MAX_FILE_BYTES) {
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error('Bu bir dosya değil.');
  if (st.size > maxBytes) {
    throw new Error(`Dosya çok büyük (${(st.size / 1048576).toFixed(1)} MB; sınır ${(maxBytes / 1048576).toFixed(0)} MB). search_files veya run_command (ör. sed -n '1,100p') ile bölüm oku.`);
  }
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 8000).includes(0)) throw new Error('İkili (binary) dosya; metin olarak okunamaz.');
  return buf.toString('utf8');
}

const truncate = (s, n = 20000) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} karakter kesildi)` : s);

module.exports = {
  checkWorkspace, classifyFile, commandWarning, resolveSafe, readTextFileSafe, truncate,
  BLOCKED_DIRS, MAX_FILE_BYTES
};
