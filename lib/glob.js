// Bağımlılıksız basit glob: **, *, ?, {a,b}
const fs = require('fs');
const path = require('path');

function globToRegex(pattern) {
  let re = '';
  let braces = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') { braces++; re += '(?:'; }
    else if (c === '}' && braces > 0) { braces--; re += ')'; }
    else if (c === ',' && braces > 0) re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// dir altında desene uyan dosyaları döndürür (dir'e göre göreli, "/" ayraçlı).
// skip(fullPath, isDir) true dönerse o giriş atlanır. Symlink'ler izlenmez.
function globFiles(dir, pattern, { skip = () => false, limit = 200, maxVisited = 50000 } = {}) {
  const re = globToRegex(pattern);
  const baseOnly = !pattern.includes('/');
  const files = [];
  let visited = 0;
  let truncated = false;
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { continue; }
    entries.sort((x, y) => x.name.localeCompare(y.name));
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, rel, e.name);
      const isDir = e.isDirectory();
      if (skip(full, isDir)) continue;
      if (++visited > maxVisited) { truncated = true; stack.length = 0; break; }
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (isDir) { stack.push(r); continue; }
      if (re.test(baseOnly ? e.name : r)) {
        if (files.length >= limit) { truncated = true; stack.length = 0; break; }
        files.push(r);
      }
    }
  }
  files.sort();
  return { files, truncated };
}

module.exports = { globToRegex, globFiles };
