import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const bin = resolve(root, 'infra/livekit/bin/livekit-server');
if (!existsSync(bin)) { console.error(`livekit-server not found at ${bin}; see infra/livekit/README.md`); process.exit(1); }
const child = spawn(bin, ['--config', resolve(root, 'e2e/livekit.e2e.yaml')], { stdio: 'inherit' });
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill(s));
child.on('exit', (c) => process.exit(c ?? 0));
