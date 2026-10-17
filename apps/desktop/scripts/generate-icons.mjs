// Renders assets/logo.svg to a 1024px PNG and runs `tauri icon` to produce every platform icon.
import sharp from 'sharp';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const png = join(root, 'assets', 'logo-1024.png');
await sharp(join(root, 'assets', 'logo.svg'), { density: 384 }).resize(1024, 1024).png().toFile(png);
execFileSync('pnpm', ['exec', 'tauri', 'icon', png, '-o', join(root, 'src-tauri', 'icons')], { stdio: 'inherit', cwd: root });
