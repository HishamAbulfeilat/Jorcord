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

function shapeSvg(shape: Shape, bg: string): string {
  const style = `fill="${bg}" stroke="#ffffff" stroke-width="6" stroke-linejoin="round"`;
  switch (shape) {
    case 'circle': return `<circle cx="80" cy="80" r="70" ${style}/>`;
    case 'square': return `<rect x="12" y="12" width="136" height="136" rx="28" ${style}/>`;
    case 'star': return `<polygon points="${POINTS(5, 74, 36)}" ${style}/>`;
    case 'burst': return `<polygon points="${POINTS(12, 74, 56)}" ${style}/>`;
    case 'heart': return `<path d="M80 144 C20 100 12 60 40 38 C58 24 76 34 80 50 C84 34 102 24 120 38 C148 60 140 100 80 144 Z" ${style}/>`;
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function svgFor(d: Def): string {
  const size = d.size ?? (d.text.length <= 2 ? 52 : d.text.length === 3 ? 42 : 34);
  const dy = d.shape === 'heart' ? 8 : d.shape === 'star' ? 14 : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160" width="160" height="160" role="img" aria-label="${esc(d.name)}"><title>${esc(d.name)}</title>${shapeSvg(d.shape, d.bg)}<text x="80" y="${(80 + size * 0.36 + dy).toFixed(1)}" font-family="Arial Black, Arial, Helvetica, sans-serif" font-weight="900" font-size="${size}" text-anchor="middle" fill="${d.fg}" transform="rotate(-8 80 80)">${esc(d.text)}</text></svg>`;
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
