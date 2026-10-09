// Renders the shared Jorcord logo into the Android mipmaps/splash/notification icon and the iOS AppIcon.
import sharp from 'sharp';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const logo = join(root, '..', 'desktop', 'assets', 'logo.svg');
const render = (size) => sharp(logo, { density: 384 }).resize(size, size).png();

const res = join(root, 'android', 'app', 'src', 'main', 'res');
if (existsSync(res)) {
  const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [d, m] of Object.entries(dens)) {
    const dir = join(res, `mipmap-${d}`);
    mkdirSync(dir, { recursive: true });
    await render(Math.round(48 * m)).toFile(join(dir, 'ic_launcher.png'));
    await render(Math.round(48 * m)).toFile(join(dir, 'ic_launcher_round.png'));
    await render(Math.round(108 * m)).toFile(join(dir, 'ic_launcher_foreground.png'));
    // white-on-transparent status bar icon
    const sd = join(res, `drawable-${d}`);
    mkdirSync(sd, { recursive: true });
    const s = Math.round(24 * m);
    const mask = await sharp(logo, { density: 384 }).resize(s, s).ensureAlpha().extractChannel('alpha').toBuffer();
    await sharp({ create: { width: s, height: s, channels: 3, background: '#ffffff' } }).joinChannel(mask).png().toFile(join(sd, 'ic_stat_jorcord.png'));
  }
  await render(480).toFile(join(res, 'drawable', 'splash.png'));
}
const ios = join(root, 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset');
if (existsSync(ios)) {
  await render(1024).flatten({ background: '#3a2fd0' }).removeAlpha().toFile(join(ios, 'AppIcon-512@2x.png'));
}
console.log('mobile assets generated');
