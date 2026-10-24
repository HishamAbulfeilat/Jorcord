/** Camera background choices. The replacement backdrops are plain gradients drawn on the canvas: original art, no image assets to ship. */

export const BACKGROUND_PRESETS = [
  { id: 'dusk', label: 'Dusk', stops: ['#2b1b4d', '#7b3f8c', '#e8886b'] },
  { id: 'aurora', label: 'Aurora', stops: ['#0b2a3a', '#1a7f77', '#7fe0b0'] },
  { id: 'paper', label: 'Paper', stops: ['#f1ece2', '#e2d9c8', '#cfc3ad'] },
  { id: 'graphite', label: 'Graphite', stops: ['#1c1d22', '#2c2f38', '#3e4350'] },
] as const;
export type BackgroundPresetId = (typeof BACKGROUND_PRESETS)[number]['id'];
export type CameraBackground = 'none' | 'blur' | BackgroundPresetId;

export const CAMERA_BACKGROUNDS: CameraBackground[] = ['none', 'blur', ...BACKGROUND_PRESETS.map((p) => p.id)];
export const isCameraBackground = (v: unknown): v is CameraBackground => typeof v === 'string' && (CAMERA_BACKGROUNDS as string[]).includes(v);
export const backgroundLabel = (b: CameraBackground) => (b === 'none' ? 'None' : b === 'blur' ? 'Blur' : BACKGROUND_PRESETS.find((p) => p.id === b)!.label);

/** Paint a preset backdrop (diagonal 3-stop gradient). */
export function paintPreset(ctx: { createLinearGradient(x0: number, y0: number, x1: number, y1: number): { addColorStop(o: number, c: string): void }; fillStyle: unknown; fillRect(x: number, y: number, w: number, h: number): void }, id: BackgroundPresetId, w: number, h: number) {
  const p = BACKGROUND_PRESETS.find((x) => x.id === id) ?? BACKGROUND_PRESETS[0];
  const g = ctx.createLinearGradient(0, 0, w, h);
  p.stops.forEach((c, i) => g.addColorStop(i / (p.stops.length - 1), c));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}
