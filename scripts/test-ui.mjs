import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, ['--test', 'test/electron-smoke.test.js'], {
  cwd: root,
  env: { ...process.env, EMOCODE_UI_SMOKE: '1' },
  stdio: 'inherit'
});

child.on('error', (error) => {
  console.error(`UI testi başlatılamadı: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
