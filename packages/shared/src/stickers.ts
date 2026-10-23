/**
 * Standard sticker packs: original, vector (SVG) stickers that ship with every Jorcord instance and can be sent anywhere
 * (servers and DMs). Ids look like `std_gg` so they never collide with snowflake ids of server stickers.
 */
export interface StandardSticker { id: string; packId: string; name: string; url: string; format: 'svg' }
export interface StandardStickerPack { id: string; name: string; description: string; stickers: StandardSticker[] }

type Shape = 'circle' | 'square' | 'star' | 'heart' | 'burst';
interface Def { slug: string; name: string; text: string; shape: Shape; bg: string; fg: string; size?: number }

const PACKS: { id: string; name: string; description: string; defs: Def[] }[] = [
  {
    id: 'std_reactions', name: 'Reactions', description: 'Quick words for every mood',
    defs: [
      { slug: 'gg', name: 'GG', text: 'GG', shape: 'burst', bg: '#f5c542', fg: '#3b2a00' },
      { slug: 'lol', name: 'LOL', text: 'LOL', shape: 'circle', bg: '#4fc3f7', fg: '#05293a' },
      { slug: 'wow', name: 'Wow', text: 'WOW', shape: 'star', bg: '#ff8a65', fg: '#3a1100' },
      { slug: 'ok', name: 'OK', text: 'OK', shape: 'circle', bg: '#81c784', fg: '#0b2d0e' },
      { slug: 'nice', name: 'Nice', text: 'NICE', shape: 'square', bg: '#ba68c8', fg: '#2a0636' },
      { slug: 'yes', name: 'Yes', text: 'YES', shape: 'square', bg: '#66bb6a', fg: '#0b2d0e' },
      { slug: 'no', name: 'No', text: 'NO', shape: 'square', bg: '#ef5350', fg: '#3a0000' },
      { slug: 'hype', name: 'Hype', text: 'HYPE', shape: 'burst', bg: '#ff5252', fg: '#fff3f0', size: 38 },
      { slug: 'rip', name: 'RIP', text: 'RIP', shape: 'square', bg: '#90a4ae', fg: '#10181c' },
      { slug: 'love', name: 'Love', text: 'LOVE', shape: 'heart', bg: '#f06292', fg: '#fff0f5', size: 30 },
    ],
  },
  {
    id: 'std_daily', name: 'Daily', description: 'Greetings and status',
    defs: [
      { slug: 'gm', name: 'Good morning', text: 'GM', shape: 'circle', bg: '#ffd54f', fg: '#3d2f00' },
      { slug: 'gn', name: 'Good night', text: 'GN', shape: 'circle', bg: '#5c6bc0', fg: '#eef0ff' },
      { slug: 'thx', name: 'Thanks', text: 'THX', shape: 'heart', bg: '#ff8a80', fg: '#3a0000' },
      { slug: 'sorry', name: 'Sorry', text: 'SRY', shape: 'square', bg: '#b0bec5', fg: '#17222a' },
      { slug: 'brb', name: 'Be right back', text: 'BRB', shape: 'burst', bg: '#4db6ac', fg: '#00221f' },
      { slug: 'afk', name: 'Away', text: 'AFK', shape: 'square', bg: '#a1887f', fg: '#241812' },
      { slug: 'hi', name: 'Hi', text: 'HI!', shape: 'star', bg: '#7986cb', fg: '#0e123a' },
      { slug: 'bye', name: 'Bye', text: 'BYE', shape: 'circle', bg: '#9575cd', fg: '#1a0b3a' },
    ],
  },
];

const POINTS = (n: number, outer: number, inner: number) => Array.from({ length: n * 2 }, (_, i) => {
  const r = i % 2 === 0 ? outer : inner; const a = (Math.PI * i) / n - Math.PI / 2;
  return `${(80 + r * Math.cos(a)).toFixed(1)},${(80 + r * Math.sin(a)).toFixed(1)}`;
}).join(' ');

/** Mix a #rrggbb colour toward white (amt > 0) or black (amt < 0). */
function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.round(amt >= 0 ? c + (255 - c) * amt : c * (1 + amt));
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => f(c).toString(16).padStart(2, '0')).join('')}`;
}

function shapeGeometry(shape: Shape, attrs: string): string {
  switch (shape) {
    case 'circle': return `<circle cx="80" cy="80" r="68" ${attrs}/>`;
    case 'square': return `<rect x="14" y="14" width="132" height="132" rx="30" ${attrs}/>`;
    case 'star': return `<polygon points="${POINTS(5, 74, 36)}" ${attrs}/>`;
    case 'burst': return `<polygon points="${POINTS(12, 74, 56)}" ${attrs}/>`;
    case 'heart': return `<path d="M80 144 C20 100 12 60 40 38 C58 24 76 34 80 50 C84 34 102 24 120 38 C148 60 140 100 80 144 Z" ${attrs}/>`;
  }
}

/** Layered artwork: soft shadow, white sticker border, vertical gradient body, inner rim, gloss highlight and sparkles. */
function shapeSvg(shape: Shape, bg: string, uid: string): string {
  const defs = `<defs><linearGradient id="${uid}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${shade(bg, 0.35)}"/><stop offset="1" stop-color="${shade(bg, -0.18)}"/></linearGradient><linearGradient id="${uid}h" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient><clipPath id="${uid}c">${shapeGeometry(shape, '')}</clipPath></defs>`;
  const shadow = `<g transform="translate(0 5)" opacity=".28">${shapeGeometry(shape, 'fill="#000" stroke="#000" stroke-width="8" stroke-linejoin="round"')}</g>`;
  const border = shapeGeometry(shape, 'fill="#fff" stroke="#fff" stroke-width="10" stroke-linejoin="round"');
  const body = shapeGeometry(shape, `fill="url(#${uid}g)" stroke="${shade(bg, -0.3)}" stroke-width="2.5" stroke-linejoin="round"`);
  const gloss = `<g clip-path="url(#${uid}c)"><ellipse cx="80" cy="34" rx="62" ry="30" fill="url(#${uid}h)"/></g>`;
  const sparkle = (x: number, y: number, r: number) => `<path d="M${x} ${y - r} Q${x} ${y} ${x + r} ${y} Q${x} ${y} ${x} ${y + r} Q${x} ${y} ${x - r} ${y} Q${x} ${y} ${x} ${y - r}Z" fill="#fff" opacity=".9"/>`;
  return `${defs}${shadow}${border}${body}${gloss}${sparkle(30, 30, 9)}${sparkle(132, 124, 6)}`;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function svgFor(d: Def): string {
  const size = d.size ?? (d.text.length <= 2 ? 52 : d.text.length === 3 ? 42 : 34);
  const dy = d.shape === 'heart' ? 8 : d.shape === 'star' ? 14 : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160" width="160" height="160" role="img" aria-label="${esc(d.name)}"><title>${esc(d.name)}</title>${shapeSvg(d.shape, d.bg, `s${d.slug}`)}<g transform="rotate(-8 80 80)" font-family="Arial Black, Arial, Helvetica, sans-serif" font-weight="900" font-size="${size}" text-anchor="middle"><text x="80" y="${(80 + size * 0.36 + dy + 2.5).toFixed(1)}" fill="#000" opacity=".22">${esc(d.text)}</text><text x="80" y="${(80 + size * 0.36 + dy).toFixed(1)}" fill="${d.fg}" stroke="${shade(d.bg, 0.55)}" stroke-width="1.5" paint-order="stroke">${esc(d.text)}</text></g></svg>`;
}

const DEFS = new Map<string, Def>(PACKS.flatMap((p) => p.defs.map((d) => [`std_${d.slug}`, d] as const)));

/** Wire path under the API root where a standard sticker image is served. */
export const standardStickerUrl = (id: string) => `/api/v1/stickers/standard/${id}.svg`;

export const STANDARD_STICKER_PACKS: StandardStickerPack[] = PACKS.map((p) => ({
  id: p.id, name: p.name, description: p.description,
  stickers: p.defs.map((d) => ({ id: `std_${d.slug}`, packId: p.id, name: d.name, url: standardStickerUrl(`std_${d.slug}`), format: 'svg' as const })),
}));

export const STANDARD_STICKERS: StandardSticker[] = STANDARD_STICKER_PACKS.flatMap((p) => p.stickers);

/** `std_` + lowercase slug. Valid syntax does not imply the sticker exists: use `isStandardStickerId`. */
export const STANDARD_STICKER_ID_RE = /^std_[a-z0-9]{1,24}$/;
export const isStandardStickerId = (id: string): boolean => DEFS.has(id);
export const standardSticker = (id: string): StandardSticker | undefined => STANDARD_STICKERS.find((s) => s.id === id);
/** The SVG markup of a standard sticker, or null for an unknown id. */
export const standardStickerSvg = (id: string): string | null => { const d = DEFS.get(id); return d ? svgFor(d) : null; };
