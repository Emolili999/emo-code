// Geri alma noktaları: araçların ve komutların çalışma klasöründe değiştirdiği dosyaların önceki hali saklanır.
const fs = require('fs');
const path = require('path');
const { readJSON, writeJSON, atomicWriteBuffer } = require('./store');
const { resolveSafe, classifyFile, BLOCKED_DIRS } = require('./security');
const { detailedDiff } = require('./diff');

const MAX_RUNS = 20;
const MAX_BACKUP_BYTES = 10 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 25 * 1024 * 1024;
const MAX_SNAPSHOT_FILES = 10000;
const SNAPSHOT_SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', 'vendor', 'dist', 'build', 'coverage', ...BLOCKED_DIRS]);

function createCheckpoints(baseDir) {
  const chatDir = (chatId) => path.join(baseDir, String(chatId).replace(/[^\w-]/g, '_'));
  const indexFile = (chatId) => path.join(chatDir(chatId), 'index.json');
  const load = (chatId) => readJSON(indexFile(chatId), []);
  const save = (chatId, idx) => writeJSON(indexFile(chatId), idx, { pretty: false });

  const begin = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  function addEntry(chatId, idx, run, file, state) {
    if (run.files.some((f) => f.path === file)) return false;
    const entry = { path: file, existed: !!state?.existed, backup: null };
    if (state?.type) entry.type = state.type;
    if (state?.mode !== undefined) entry.mode = state.mode;
    if (state?.followSymlink) entry.followSymlink = true;
    if (state?.symlinkTarget !== undefined) entry.symlinkTarget = state.symlinkTarget;
    if (state?.tooBig) entry.tooBig = true;

    if (entry.existed && state?.type !== 'symlink') {
      const data = state?.content;
      if (Buffer.isBuffer(data) && data.length <= MAX_BACKUP_BYTES) {
        entry.backup = `${run.run}-${run.files.length}`;
        fs.mkdirSync(chatDir(chatId), { recursive: true });
        fs.writeFileSync(path.join(chatDir(chatId), entry.backup), data, { mode: 0o600 });
      } else if (!state?.symlinkTarget) {
        entry.tooBig = true;
      }
    }
    run.files.push(entry);
    return true;
  }

  function getRun(chatId, runId, root, idx = load(chatId)) {
    let run = idx.find((r) => r.run === runId);
    if (!run) {
      run = { run: runId, time: Date.now(), root: fs.realpathSync(root), files: [] };
      idx.push(run);
    }
    return run;
  }

  // Dosya değiştirilmeden ÖNCE çağrılır. Bir metin dosyası kadar ikili dosya da bayt bayt yedeklenir.
  function record(chatId, runId, root, file) {
    try {
      const idx = load(chatId);
      const run = getRun(chatId, runId, root, idx);
      if (classifyFile(run.root, file) === 'block') return;
      if (run.files.some((f) => f.path === file)) return;
      let state = { existed: false, type: 'file' };
      try {
        const isLink = fs.lstatSync(file).isSymbolicLink();
        if (isLink) resolveSafe(run.root, path.relative(run.root, file));
        const st = fs.statSync(file); // doğrudan dosya araçları için symlink hedefi yedeklenir
        if (st.isFile()) {
          state = { existed: true, type: 'file', mode: st.mode & 0o777, size: st.size, followSymlink: isLink };
          if (st.size <= MAX_BACKUP_BYTES) state.content = fs.readFileSync(file);
          else state.tooBig = true;
        } else {
          // Dizinler yedeklenmez; araçlar normalde dosya yollarıyla çalışır.
          state = { existed: true, type: 'other', tooBig: true };
        }
      } catch { /* dosya yok veya geçersiz symlink: yeni dosya olacak */ }
      addEntry(chatId, idx, run, file, state);
      trimRuns(chatId, idx);
      save(chatId, idx);
    } catch { /* yedekleme hatası işlemi engellemesin; kullanıcıya geri alınamayabileceği bildirilir */ }
  }

  function trimRuns(chatId, idx) {
    while (idx.length > MAX_RUNS) {
      const old = idx.shift();
      for (const f of old.files) if (f.backup) fs.rmSync(path.join(chatDir(chatId), f.backup), { force: true });
    }
  }

  // Komut çalıştırılmadan önce klasör durumunu al. Büyük/vendor dizinleri tarama dışıdır;
  // içerik bütçesi aşılırsa metadata tutulur ve değişen büyük dosyalar için açık uyarı döner.
  function snapshotWorkspace(root) {
    const realRoot = fs.realpathSync(root);
    const files = new Map();
    let bytes = 0, count = 0, truncated = false;

    function walk(dir) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { truncated = true; return; }
      for (const entry of entries) {
        if (entry.isDirectory() && SNAPSHOT_SKIP_DIRS.has(entry.name)) { truncated = true; continue; }
        if (count >= MAX_SNAPSHOT_FILES) { truncated = true; return; }
        const full = path.join(dir, entry.name);
        if (classifyFile(realRoot, full) === 'block') continue;
        const rel = path.relative(realRoot, full);
        let st;
        try { st = fs.lstatSync(full); } catch { truncated = true; continue; }
        count++;
        if (st.isSymbolicLink()) {
          let target;
          try { target = fs.readlinkSync(full); } catch { truncated = true; continue; }
          files.set(rel, { type: 'symlink', symlinkTarget: target, mode: st.mode & 0o777, size: Buffer.byteLength(target), mtimeMs: st.mtimeMs });
          continue;
        }
        if (st.isDirectory()) { walk(full); continue; }
        if (!st.isFile()) continue;
        const meta = { type: 'file', mode: st.mode & 0o777, size: st.size, mtimeMs: st.mtimeMs, content: null };
        if (st.size <= MAX_BACKUP_BYTES && bytes + st.size <= MAX_SNAPSHOT_BYTES) {
          try {
            const content = fs.readFileSync(full);
            meta.content = content;
            bytes += content.length;
          } catch { meta.unreadable = true; truncated = true; }
        } else {
          meta.tooBig = true;
          truncated = true;
        }
        files.set(rel, meta);
      }
    }
    walk(realRoot);
    return { root: realRoot, files, truncated, count, bytes };
  }

  function sameState(a, b) {
    if (!a || !b || a.type !== b.type) return false;
    if (a.type === 'symlink') return a.symlinkTarget === b.symlinkTarget;
    if (Buffer.isBuffer(a.content) && Buffer.isBuffer(b.content)) return a.content.equals(b.content) && a.mode === b.mode;
    return a.size === b.size && a.mtimeMs === b.mtimeMs && a.mode === b.mode;
  }

  // Komut sonrasında farkları kaydeder; yeni/değişmiş/silinmiş dosyalar geri alma grubuna eklenir.
  function recordWorkspaceChanges(chatId, runId, root, before) {
    if (!before?.files || !before.root) return { changed: 0, warning: 'Komut değişiklikleri geri alma için izlenemedi.' };
    let after;
    try { after = snapshotWorkspace(root); } catch (e) {
      return { changed: 0, warning: `Komut değişiklikleri taranamadı: ${e.message}` };
    }
    const paths = [...new Set([...before.files.keys(), ...after.files.keys()])].sort((a, b) => {
      const depth = a.split(path.sep).length - b.split(path.sep).length;
      return depth || a.localeCompare(b);
    });
    const idx = load(chatId);
    const run = getRun(chatId, runId, root, idx);
    let changed = 0, unrestoreable = 0;

    for (const rel of paths) {
      const oldState = before.files.get(rel);
      const newState = after.files.get(rel);
      if (oldState && newState && sameState(oldState, newState)) continue;
      // İki taramada da içerik bütçesi nedeniyle metadata saklandıysa değişim yine de fark edilir.
      const full = path.resolve(before.root, rel);
      const relative = path.relative(before.root, full);
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue;
      let state;
      if (!oldState) {
        state = { existed: false, type: newState?.type || 'file' };
      } else if (oldState.type === 'symlink') {
        state = { existed: true, type: 'symlink', symlinkTarget: oldState.symlinkTarget, mode: oldState.mode };
      } else if (Buffer.isBuffer(oldState.content)) {
        state = { existed: true, type: 'file', content: oldState.content, mode: oldState.mode };
      } else {
        state = { existed: true, type: 'file', tooBig: true, mode: oldState.mode };
        unrestoreable++;
      }
      const added = addEntry(chatId, idx, run, full, state);
      if (added) changed++;
    }

    trimRuns(chatId, idx);
    save(chatId, idx);
    const warnings = [];
    if (before.truncated || after.truncated) warnings.push('Bazı dosyalar boyut/klasör sınırları nedeniyle izlenemedi; .git, node_modules, vendor, build ve benzeri klasörler kapsam dışı.');
    if (unrestoreable) warnings.push(`${unrestoreable} değişen dosya yedek sınırını aştığı için geri yüklenemez.`);
    return { changed, warning: warnings.join(' ') };
  }

  function summary(chatId) {
    const idx = load(chatId).filter((r) => r.files.length);
    const last = idx[idx.length - 1];
    return last ? { runs: idx.length, files: last.files.length } : { runs: 0, files: 0 };
  }

  function undoRun(chatId, runId) {
    const idx = load(chatId);
    const last = [...idx].reverse().find((run) => run.files.length);
    if (!last || last.run !== runId) {
      return { ok: false, message: 'Bu çalışma artık son değişiklik değil. Daha yeni değişiklikleri korumak için yalnızca en son çalışma geri alınabilir.' };
    }
    return undoLast(chatId);
  }

  function safeRestoreTarget(root, full) {
    const absolute = path.resolve(root, full);
    const rel = path.relative(root, absolute);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Yol çalışma klasörünün dışında.');
    const parentRel = path.relative(root, path.dirname(absolute)) || '.';
    resolveSafe(root, parentRel); // üst dizinlerin symlink ile dışarı çıkmasını engeller
    return absolute;
  }

  function undoLast(chatId) {
    const idx = load(chatId);
    while (idx.length && !idx[idx.length - 1].files.length) idx.pop();
    const run = idx.pop();
    if (!run) return { ok: false, message: 'Geri alınacak değişiklik yok.' };
    const lines = [];
    for (const f of [...run.files].reverse()) {
      const rel = path.relative(run.root, f.path);
      let target;
      try {
        target = safeRestoreTarget(run.root, f.path);
        const st = (() => { try { return fs.lstatSync(target); } catch { return null; } })();
        if (f.existed) {
          if (f.tooBig || (!f.backup && f.type !== 'symlink')) {
            lines.push(`⚠ ${rel}: yedek yok veya dosya çok büyük; geri yüklenemedi`);
            continue;
          }
          if (f.type === 'symlink') {
            const symAbs = path.resolve(path.dirname(target), String(f.symlinkTarget ?? ''));
            const symRel = path.relative(run.root, symAbs);
            if (symRel === '..' || symRel.startsWith('..' + path.sep) || path.isAbsolute(symRel)) {
              throw new Error('Symlink hedefi çalışma klasörünün dışında.');
            }
            if (st) fs.rmSync(target, { recursive: false, force: true });
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.symlinkSync(f.symlinkTarget, target);
          } else {
            // Son bileşen symlink ise hedef dosyaya yazmak yerine linki kaldır (veya iç hedefi doğrula).
            if (st?.isSymbolicLink()) {
              if (f.followSymlink) resolveSafe(run.root, rel);
              else fs.unlinkSync(target);
            } else if (st?.isDirectory()) fs.rmdirSync(target);
            const data = fs.readFileSync(path.join(chatDir(chatId), f.backup));
            atomicWriteBuffer(target, data, { mode: f.mode });
          }
          lines.push(`↩ ${rel}: önceki haline döndürüldü`);
        } else {
          if (st?.isDirectory()) fs.rmdirSync(target); // boşsa kaldır; içeriği zorla silme
          else if (st) fs.rmSync(target, { force: true });
          lines.push(`🗑 ${rel}: oluşturulan dosya silindi`);
        }
      } catch (e) {
        lines.push(`⚠ ${rel}: ${e.message}`);
      }
      if (f.backup) fs.rmSync(path.join(chatDir(chatId), f.backup), { force: true });
    }
    save(chatId, idx);
    return { ok: true, message: `Son çalışmadaki değişiklikler geri alındı:\n${lines.join('\n')}` };
  }

  function undoAll(chatId) {
    const messages = [];
    while (summary(chatId).runs > 0) {
      const r = undoLast(chatId);
      if (!r.ok) break;
      const body = r.message.replace(/^Son çalışmadaki değişiklikler geri alındı:\n?/, '');
      if (body) messages.push(body);
    }
    if (!messages.length) return { ok: false, message: 'Geri alınacak değişiklik yok.' };
    return { ok: true, message: `Oturumdaki tüm değişiklikler geri alındı:\n${messages.join('\n')}` };
  }

  function undoFile(chatId, filePath) {
    const idx = load(chatId);
    let foundRun = null;
    let foundEntry = null;

    // En eski kaydı bul (oturum başındaki orijinal durumu geri yüklemek için)
    for (let r = 0; r < idx.length; r++) {
      const run = idx[r];
      const i = run.files.findIndex((f) => f.path === filePath);
      if (i !== -1) {
        foundRun = run;
        foundEntry = run.files[i];
        break;
      }
    }

    if (!foundEntry) return { ok: false, message: 'Bu dosya için geri alma kaydı bulunamadı.' };

    const rel = path.relative(foundRun.root, foundEntry.path);
    try {
      const target = safeRestoreTarget(foundRun.root, foundEntry.path);
      const st = (() => { try { return fs.lstatSync(target); } catch { return null; } })();
      if (foundEntry.existed) {
        if (foundEntry.tooBig || (!foundEntry.backup && foundEntry.type !== 'symlink')) {
          return { ok: false, message: `${rel}: yedek bulunamadı veya dosya çok büyük.` };
        }
        if (foundEntry.type === 'symlink') {
          const symAbs = path.resolve(path.dirname(target), String(foundEntry.symlinkTarget ?? ''));
          const symRel = path.relative(foundRun.root, symAbs);
          if (symRel === '..' || symRel.startsWith('..' + path.sep) || path.isAbsolute(symRel)) {
            throw new Error('Symlink hedefi çalışma klasörünün dışında.');
          }
          if (st) fs.rmSync(target, { recursive: false, force: true });
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.symlinkSync(foundEntry.symlinkTarget, target);
        } else {
          if (st?.isSymbolicLink()) {
            if (foundEntry.followSymlink) resolveSafe(foundRun.root, rel);
            else fs.unlinkSync(target);
          } else if (st?.isDirectory()) {
            fs.rmdirSync(target);
          }
          const data = fs.readFileSync(path.join(chatDir(chatId), foundEntry.backup));
          atomicWriteBuffer(target, data, { mode: foundEntry.mode });
        }
      } else {
        if (st?.isDirectory()) fs.rmdirSync(target);
        else if (st) fs.rmSync(target, { force: true });
      }
      // Tüm çalışmalardaki bu dosyaya ait kayıtları ve yedeklerini temizle
      for (const run of idx) {
        for (let i = run.files.length - 1; i >= 0; i--) {
          if (run.files[i].path === filePath) {
            if (run.files[i].backup) {
              fs.rmSync(path.join(chatDir(chatId), run.files[i].backup), { force: true });
            }
            run.files.splice(i, 1);
          }
        }
      }
      const cleaned = idx.filter((r) => r.files.length > 0);
      save(chatId, cleaned);
      return { ok: true, message: `${rel} başarıyla geri alındı.` };
    } catch (e) {
      return { ok: false, message: `Geri alma hatası: ${e.message}` };
    }
  }

  function getChangesDetails(chatId, runId = null) {
    const allRuns = load(chatId);
    const idx = runId ? allRuns.filter((run) => run.run === runId) : allRuns;
    const fileMap = new Map(); // path -> { entry, root }

    // En baştan en sona: ilk kez ne zaman yedeklendiyse o orijinal hali baz alınır
    for (const run of idx) {
      for (const f of run.files) {
        if (!fileMap.has(f.path)) {
          fileMap.set(f.path, { entry: f, root: run.root });
        }
      }
    }

    const resultFiles = [];
    let totalAdditions = 0;
    let totalDeletions = 0;

    for (const [filePath, { entry, root }] of fileMap.entries()) {
      const rel = path.relative(root, filePath).split(path.sep).join('/');
      let oldText = null;
      let newText = null;
      let isBinary = false;
      let status = 'modified';

      // Önceki içerik
      if (entry.existed) {
        if (entry.backup) {
          const bPath = path.join(chatDir(chatId), entry.backup);
          try {
            const buf = fs.readFileSync(bPath);
            if (buf.subarray(0, 8000).includes(0)) {
              isBinary = true;
            } else {
              oldText = buf.toString('utf8');
            }
          } catch {
            oldText = null;
          }
        } else {
          isBinary = true;
        }
      } else {
        oldText = '';
        status = 'created';
      }

      // Mevcut içerik
      try {
        if (fs.existsSync(filePath)) {
          const st = fs.statSync(filePath);
          if (st.isFile()) {
            const buf = fs.readFileSync(filePath);
            if (buf.subarray(0, 8000).includes(0)) {
              isBinary = true;
            } else {
              newText = buf.toString('utf8');
            }
          }
        } else {
          newText = '';
          status = 'deleted';
        }
      } catch {
        newText = null;
      }

      let additions = 0;
      let deletions = 0;
      let lines = [];
      let totalOldLines = 0;
      let totalNewLines = 0;

      if (isBinary) {
        status = 'binary';
      } else if (oldText !== null && newText !== null) {
        if (status !== 'created' && status !== 'deleted' && oldText === newText) {
          continue; // Değişiklik kalmamışsa listeleme
        }
        const diffRes = detailedDiff(oldText, newText);
        additions = diffRes.additions;
        deletions = diffRes.deletions;
        lines = diffRes.lines;
        totalOldLines = diffRes.totalOldLines;
        totalNewLines = diffRes.totalNewLines;
        totalAdditions += additions;
        totalDeletions += deletions;
      }

      resultFiles.push({
        path: filePath,
        relativePath: rel,
        status,
        isBinary,
        additions,
        deletions,
        lines,
        totalOldLines,
        totalNewLines
      });
    }

    return {
      runsCount: idx.length,
      totalFiles: resultFiles.length,
      totalAdditions,
      totalDeletions,
      files: resultFiles
    };
  }

  function remove(chatId) {
    try { fs.rmSync(chatDir(chatId), { recursive: true, force: true }); } catch { /* yok */ }
  }

  return { begin, record, snapshotWorkspace, recordWorkspaceChanges, summary, getChangesDetails, undoLast, undoRun, undoAll, undoFile, remove };
}

module.exports = { createCheckpoints, MAX_BACKUP_BYTES, MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_FILES };
