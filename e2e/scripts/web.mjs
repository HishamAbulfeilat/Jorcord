// Vite dev server on :5273 proxying /api and /gateway to the e2e API on :3100.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const child = spawn(process.execPath, [resolve(root, 'apps/web/node_modules/vite/bin/vite.js'), '--port', '5273', '--strictPort', '--host', '127.0.0.1'], {
  cwd: resolve(root, 'apps/web'), stdio: 'inherit', env: { ...process.env, JORCORD_SERVER: 'http://127.0.0.1:3100' },
});
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill(s));
child.on('exit', (c) => process.exit(c ?? 0));
