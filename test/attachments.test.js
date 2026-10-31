const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAttachments } = require('../lib/attachments');
const { dropOldImages, dropOldFiles } = require('../lib/context');
const { createApprovals } = require('../lib/approvals');

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const PDF = 'data:application/pdf;base64,JVBERi0xLjQK';

test('attachments: save/ref aynı içerik için tek dosya, resolveForApi image_ref çözer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'att-'));
  const a = createAttachments(dir);
  const r1 = a.save(PNG);
  const r2 = a.save(PNG);
  assert.equal(r1.ref, r2.ref);
  assert.equal(fs.readdirSync(dir).length, 1);
  assert.equal(a.readAsDataUrl(r1.ref), PNG);
  const [m] = a.resolveForApi([{ role: 'user', content: [{ type: 'image_ref', ref: r1.ref }] }]);
  assert.equal(m.content[0].type, 'image_url');
  const pdf = a.save(PDF);
  const [pdfMessage] = a.resolveForApi([{ role: 'user', content: [{ type: 'file_ref', ref: pdf.ref, filename: 'report.pdf' }] }]);
  assert.deepEqual(pdfMessage.content[0], { type: 'file', file: { filename: 'report.pdf', file_data: PDF } });
  assert.equal(fs.readdirSync(dir).length, 2);
  assert.throws(() => a.save('data:text/html;base64,AAAA'));
  assert.throws(() => a.readAsDataUrl('../etc/passwd'));
  assert.equal(a.removeMany([r1.ref, pdf.ref]) >= 2, true);
});

test('context: dropOldImages yalnızca en yeni görselleri korur', () => {
  const img = { type: 'image_url', image_url: { url: PNG } };
  const msgs = [1, 2, 3].map(() => ({ role: 'user', content: [{ type: 'text', text: 'x' }, img] }));
  const out = dropOldImages(msgs, 2);
  assert.equal(out[0].content[1].type, 'text');
  assert.equal(out[1].content[1].type, 'image_url');
  assert.equal(out[2].content[1].type, 'image_url');
});

test('context: dropOldFiles eski PDF payloadlarını bağlamdan çıkarır', () => {
  const file = { type: 'file', file: { filename: 'report.pdf', file_data: PDF } };
  const out = dropOldFiles([
    { role: 'user', content: [file] },
    { role: 'user', content: [{ type: 'text', text: 'son soru' }, file] }
  ], 1);
  assert.deepEqual(out[0].content, [{ type: 'text', text: '[PDF: report.pdf bağlamdan çıkarıldı]' }]);
  assert.equal(out[1].content[1].type, 'file');
});

test('approvals: yanıt sonrası abort dinleyicisi kaldırılır', async () => {
  const ap = createApprovals();
  const ac = new AbortController();
  let removed = 0;
  const orig = ac.signal.removeEventListener.bind(ac.signal);
  ac.signal.removeEventListener = (...a) => { removed++; return orig(...a); };
  let evt;
  const p = ap.ask({ send: (t, d) => { evt = d; }, ac, question: 'q', options: [] });
  ap.respond(evt.id, 'evet');
  assert.equal(await p, 'evet');
  assert.equal(removed, 1);
});
