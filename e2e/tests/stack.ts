/**
 * A production-like stack for e2e: the server serving the BUILT web app (WEB_DIST, its own CSP, same origin) plus a LiveKit
 * started with the exact `rtc`/`room` config from docker-compose.yml (ports remapped). Processes can be killed/restarted mid-test.
 */
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const PORTS = { server: 3120, livekit: 7895, lkTcp: 7896, lkMux: 7897, udpStart: 52000, udpEnd: 52100 };
const KEY = 'jorcord'; const SECRET = 'e2e-livekit-secret-0123456789abcdef0123';

/** LIVEKIT_CONFIG from docker-compose.yml with ${VAR:-default} resolved and ports remapped for the test machine. */
export function composeLivekitConfig(env: Record<string, string> = {}, o: { onlyAdvertised?: boolean } = {}): string {
  const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8');
  const m = /LIVEKIT_CONFIG: \|\n([\s\S]*?)\n    ports:/.exec(compose);
  if (!m) throw new Error('LIVEKIT_CONFIG not found in docker-compose.yml');
  let cfg = m[1]!.split('\n').map((l) => l.slice(8)).join('\n');
  const vars: Record<string, string> = { LIVEKIT_API_KEY: KEY, LIVEKIT_API_SECRET: SECRET, ...env };
  cfg = cfg.replace(/\$\{(\w+)(?::\?[^}]*|(:-|-)([^}]*))?\}/g, (_x, name: string, op?: string, dflt?: string) => {
    if (name in vars) return vars[name]!;
    return op ? (dflt ?? '') : '';
  });
  // `onlyAdvertised`: behave like a container whose only candidate is the advertised one (no host/loopback candidates)
  if (o.onlyAdvertised) cfg = cfg.replace(/^rtc:$/m, 'rtc:\n  ips:\n    excludes: ["0.0.0.0/0", "::/0"]');
  return cfg
    .replace(/^port: 7880$/m, `port: ${PORTS.livekit}`).replace('tcp_port: 7881', `tcp_port: ${PORTS.lkTcp}`)
    .replace('port_range_start: 50000', `port_range_start: ${PORTS.udpStart}`).replace('port_range_end: 50200', `port_range_end: ${PORTS.udpEnd}`)
    .replace('udp_port: 3478', 'udp_port: 3497').replace('log_level: info', 'log_level: warn')
    .replace('http://server:3000/api/v1/voice/webhook', `http://127.0.0.1:${PORTS.server}/api/v1/voice/webhook`);
}

const newest = (dir: string, skip = /node_modules|dist/): number => {
  let t = 0;
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    if (skip.test(f.name)) continue;
    const p = join(dir, f.name);
    t = Math.max(t, f.isDirectory() ? newest(p, skip) : statSync(p).mtimeMs);
  }
  return t;
};
/** Build the web client if dist is missing or older than its sources (or packages/voice, packages/shared). */
let built = false;
export function ensureWebBuild(): string {
  const dist = join(root, 'apps/web/dist');
  const stamp = existsSync(join(dist, 'index.html')) ? statSync(join(dist, 'index.html')).mtimeMs : 0;
  const src = Math.max(newest(join(root, 'apps/web/src')), newest(join(root, 'packages/voice/src')), newest(join(root, 'packages/shared/src')));
  if (!built && (!stamp || src > stamp)) execSync('pnpm --filter @jorcord/web build', { cwd: root, stdio: 'inherit', env: { ...process.env, VITE_BASE: '/' }, timeout: 280_000 });
  built = true;
  return dist;
}

const portOpen = (port: number) => new Promise<boolean>((res) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); res(true); }); s.once('error', () => res(false)); });
async function waitPort(port: number, up: boolean, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if ((await portOpen(port)) === up) return; await new Promise((r) => setTimeout(r, 150)); }
  throw new Error(`port ${port} did not go ${up ? 'up' : 'down'}`);
}

export class Stack {
  lk?: ChildProcess; srv?: ChildProcess; data = resolve(root, 'e2e/.data-prod');
  origin = `http://localhost:${PORTS.server}`;
  constructor(private o: { livekitUrl?: string } = {}) {}

  async startLivekit(env: Record<string, string> = {}, o: { onlyAdvertised?: boolean } = {}) {
    const cfg = join(this.data, 'livekit.yaml'); mkdirSync(this.data, { recursive: true });
    writeFileSync(cfg, composeLivekitConfig(env, o));
    this.lk = spawn(resolve(root, 'infra/livekit/bin/livekit-server'), ['--config', cfg], { stdio: 'ignore' });
    await waitPort(PORTS.livekit, true, 30_000);
  }
  async killLivekit() { const p = this.lk; this.lk = undefined; if (p && p.exitCode === null) { p.kill('SIGKILL'); await waitPort(PORTS.livekit, false, 15_000); } }

  async startServer() {
    this.srv = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: resolve(root, 'apps/server'), stdio: 'ignore',
      env: {
        ...process.env, NODE_ENV: 'production', DATA_DIR: this.data, PORT: String(PORTS.server), HOST: '127.0.0.1', PUBLIC_URL: this.origin, RATE_LIMIT_ENABLED: 'false', LOG_LEVEL: 'warn',
        JWT_SECRET: 'e2e-prod-jwt-secret-0123456789abcdef0123456789', WEB_DIST: ensureWebBuild(), STORAGE_DRIVER: 'local',
        LIVEKIT_URL: this.o.livekitUrl ?? 'auto', LIVEKIT_API_URL: `http://127.0.0.1:${PORTS.livekit}`, LIVEKIT_API_KEY: KEY, LIVEKIT_API_SECRET: SECRET,
      },
    });
    await waitPort(PORTS.server, true, 90_000);
  }
  async killServer() { const p = this.srv; this.srv = undefined; if (p && p.exitCode === null) { p.kill('SIGKILL'); await waitPort(PORTS.server, false, 15_000); } }

  async up() { rmSync(this.data, { recursive: true, force: true }); mkdirSync(this.data, { recursive: true }); await this.startLivekit(); await this.startServer(); }
  async down() { await this.killServer(); await this.killLivekit(); rmSync(this.data, { recursive: true, force: true }); }
}
