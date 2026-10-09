export type NetworkQuality = 'excellent' | 'good' | 'poor' | 'lost' | 'unknown';
export function mapConnectionQuality(q: string | undefined): NetworkQuality {
  switch (q) { case 'excellent': case 'good': case 'poor': case 'lost': return q; default: return 'unknown'; }
}
export const qualityBars = (q: NetworkQuality) => ({ excellent: 3, good: 2, poor: 1, lost: 0, unknown: 0 })[q];

/** Compute kbps from two cumulative byte counters. */
export function bitrateKbps(prevBytes: number, prevTs: number, bytes: number, ts: number): number {
  const dt = (ts - prevTs) / 1000;
  if (dt <= 0 || bytes < prevBytes) return 0;
  return Math.round(((bytes - prevBytes) * 8) / dt / 1000);
}

export interface StreamStats {
  bitrateKbps: number; fps: number; width: number; height: number; codec: string; rttMs: number | null;
  packetsLost?: number; qualityLimitation?: string; layer?: string;
}
export const formatKbps = (k: number) => (k >= 1000 ? `${(k / 1000).toFixed(1)} Mbps` : `${k} kbps`);
