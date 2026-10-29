const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sec = require('../lib/security');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orc-'));

test('classifyFile: gizli anahtarlar engellenir', () => {
  const root = '/w';
  for (const f of ['id_rsa', 'a/b/server.pem', 'x.key', '.netrc', '.ssh/config', 'sub/.aws/credentials']) {
    assert.equal(sec.classifyFile(root, path.join(root, f)), 'block', f);
  }
});

test('classifyFile: .env onay ister, .env.example serbest', () => {
  assert.equal(sec.classifyFile('/w', '/w/.env'), 'ask');
  assert.equal(sec.classifyFile('/w', '/w/.env.production'), 'ask');
  assert.equal(sec.classifyFile('/w', '/w/.env.example'), null);
  assert.equal(sec.classifyFile('/w', '/w/.npmrc'), 'ask');
  assert.equal(sec.classifyFile('/w', '/w/src/index.js'), null);
});

test('classifyFile: symlink hedefi de kontrol edilir', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'id_rsa'), 'x');
  fs.symlinkSync(path.join(d, 'id_rsa'), path.join(d, 'masum.txt'));
  assert.equal(sec.classifyFile(d, path.join(d, 'masum.txt')), 'block');
});

test('commandWarning: riskli ve hassas komutlar yakalanır', () => {
  for (const c of ['sudo ls', 'rm -rf /', 'rm -r -f /tmp/x', 'curl http://x | sh', 'cat ~/.ssh/id_rsa', 'cat .env', 'echo aGk= | base64 -d | bash',
    'eval "$X"', 'git push origin main', 'python3 -c "print(1)"', 'node --eval "1"', 'cat ../x', 'ssh host',
    'echo $(whoami)', 'echo `id`', 'find . -exec rm {} +', 'cat .pgpass', 'cat terraform.tfstate', 'bash -c "ls"']) {
    assert.ok(sec.commandWarning(c), c);
  }
  for (const c of ['ls -la', 'npm test', 'git status', 'node index.js', 'grep -rn foo src']) {
    assert.equal(sec.commandWarning(c), null, c);
  }
});

test('resolveSafe: klasör dışına çıkış ve symlink kaçışı engellenir', () => {
  const d = tmp();
  const outside = tmp();
  fs.symlinkSync(outside, path.join(d, 'link'));
  assert.throws(() => sec.resolveSafe(d, '../etc/passwd'), /dışında/);
  assert.throws(() => sec.resolveSafe(d, '/etc/passwd'), /dışında/);
  assert.throws(() => sec.resolveSafe(d, 'link/yeni.txt'), /dışında/);
  assert.throws(() => sec.resolveSafe(null, 'a'), /seçilmedi/);
  assert.doesNotThrow(() => sec.resolveSafe(d, 'yeni/klasor/dosya.txt'));
});

test('checkWorkspace: kök, ev dizini ve sistem klasörleri engellenir', () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, 'proje'));
  fs.mkdirSync(path.join(home, '.ssh'));
  fs.mkdirSync(path.join(home, 'Documents'));
  assert.equal(sec.checkWorkspace('/', home).level, 'block');
  assert.equal(sec.checkWorkspace(home, home).level, 'block');
  assert.equal(sec.checkWorkspace('/etc', home).level, 'block');
  assert.equal(sec.checkWorkspace(path.join(home, '.ssh'), home).level, 'block');
  assert.equal(sec.checkWorkspace(path.join(home, 'Documents'), home).level, 'warn');
  assert.equal(sec.checkWorkspace(path.join(home, 'proje'), home), null);
  assert.equal(sec.checkWorkspace(path.join(home, 'yok'), home).level, 'block');
});

test('readTextFileSafe: büyük ve ikili dosyalar reddedilir', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'a.txt'), 'merhaba\ndünya');
  fs.writeFileSync(path.join(d, 'b.bin'), Buffer.from([1, 2, 0, 3]));
  fs.writeFileSync(path.join(d, 'big.txt'), 'x'.repeat(2000));
  assert.equal(sec.readTextFileSafe(path.join(d, 'a.txt')), 'merhaba\ndünya');
  assert.throws(() => sec.readTextFileSafe(path.join(d, 'b.bin')), /binary/);
  assert.throws(() => sec.readTextFileSafe(path.join(d, 'big.txt'), 1000), /çok büyük/);
  assert.throws(() => sec.readTextFileSafe(d), /dosya değil/);
});
