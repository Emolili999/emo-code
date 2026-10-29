// Basit satır tabanlı diff. Çıktı satırları: "+ ", "- ", "  " ile başlar; atlanan bölümler "…" ile gösterilir.

const split = (t) => (t === '' ? [] : t.split('\n'));

function lcsOps(a, b) {
  const n = a.length, m = b.length, w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { ops.push(['-', a[i]]); i++; }
    else { ops.push(['+', b[j]]); j++; }
  }
  while (i < n) ops.push(['-', a[i++]]);
  while (j < m) ops.push(['+', b[j++]]);
  return ops;
}

function lineDiff(oldText, newText, context = 3, maxCells = 4_000_000) {
  const a = split(oldText), b = split(newText);
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const am = a.slice(s, ea), bm = b.slice(s, eb);
  if (!am.length && !bm.length) return '(değişiklik yok)';

  const mid = am.length * bm.length > maxCells
    ? [...am.map((l) => ['-', l]), ...bm.map((l) => ['+', l])]
    : lcsOps(am, bm);
  const all = [...a.slice(0, s).map((l) => [' ', l]), ...mid, ...a.slice(ea).map((l) => [' ', l])];

  const keep = new Array(all.length).fill(false);
  all.forEach(([t], i) => {
    if (t === ' ') return;
    for (let k = Math.max(0, i - context); k <= Math.min(all.length - 1, i + context); k++) keep[k] = true;
  });

  const out = [];
  let skipped = false;
  all.forEach(([t, l], i) => {
    if (keep[i]) { out.push(`${t} ${l}`); skipped = false; }
    else if (!skipped) { out.push('…'); skipped = true; }
  });
  return out.join('\n');
}

function detailedDiff(oldText = '', newText = '', context = 4, maxCells = 4_000_000) {
  const a = split(String(oldText ?? ''));
  const b = split(String(newText ?? ''));
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const am = a.slice(s, ea), bm = b.slice(s, eb);

  const mid = am.length * bm.length > maxCells
    ? [...am.map((l) => ['-', l]), ...bm.map((l) => ['+', l])]
    : lcsOps(am, bm);
  const all = [...a.slice(0, s).map((l) => [' ', l]), ...mid, ...a.slice(ea).map((l) => [' ', l])];

  let additions = 0;
  let deletions = 0;
  let oldLine = 1;
  let newLine = 1;

  const rawLines = all.map(([op, text]) => {
    if (op === '+') {
      additions++;
      return { type: 'add', oldLineNo: null, newLineNo: newLine++, text };
    }
    if (op === '-') {
      deletions++;
      return { type: 'del', oldLineNo: oldLine++, newLineNo: null, text };
    }
    return { type: 'same', oldLineNo: oldLine++, newLineNo: newLine++, text };
  });

  const keep = new Array(rawLines.length).fill(false);
  rawLines.forEach((l, i) => {
    if (l.type !== 'same') {
      for (let k = Math.max(0, i - context); k <= Math.min(rawLines.length - 1, i + context); k++) {
        keep[k] = true;
      }
    }
  });

  const lines = rawLines.map((l, i) => ({ ...l, inContext: keep[i] }));
  return { additions, deletions, lines, totalOldLines: a.length, totalNewLines: b.length };
}

module.exports = { lineDiff, detailedDiff };
