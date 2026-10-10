// Starts the Jorcord API on :3100 with a brand-new data directory (wiped on every run).
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const data = resolve(root, 'e2e/.data');
rmSync(data, { recursive: true, force: true }); mkdirSync(data, { recursive: true });
const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
  cwd: resolve(root, 'apps/server'), stdio: 'inherit',
  env: { ...process.env, DATA_DIR: data, PORT: '3100', HOST: '127.0.0.1', PUBLIC_URL: 'http://127.0.0.1:3100', RATE_LIMIT_ENABLED: 'false', LOG_LEVEL: 'warn', CORS_ORIGINS: 'http://127.0.0.1:5273,http://localhost:5273',
    LIVEKIT_URL: 'ws://127.0.0.1:7890', LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'secret' },
});
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill(s));
child.on('exit', (c) => process.exit(c ?? 0));
