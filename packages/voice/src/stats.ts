import { bitrateKbps, type StreamStats } from './network';

export interface StatsSample { bytes: number; ts: number }

/** Parse an RTCStatsReport (or array of stats) for one video RTP stream. Pure; pass previous sample to get bitrate. */
export function parseVideoStats(
  report: Iterable<any> | Map<string, any>,
  dir: 'outbound' | 'inbound',
  prev?: StatsSample,
): { stats: StreamStats; sample: StatsSample } {
  // RTCStatsReport is a maplike (iterates [id, stat] pairs) but is not `instanceof Map`; arrays/iterables of stats also accepted.
  const all: any[] = typeof (report as any).values === 'function' && !Array.isArray(report) ? Array.from((report as Map<string, any>).values()) : Array.from(report as Iterable<any>);
  const byId = new Map(all.map((s) => [s.id, s]));
  const rtps = all.filter((s) => s.type === `${dir}-rtp` && (s.kind ?? s.mediaType) === 'video');
  // for simulcast outbound pick the highest-resolution active layer; bytes are summed across layers
  rtps.sort((a, b) => (b.frameWidth ?? 0) - (a.frameWidth ?? 0));
  const top = rtps[0] ?? {};
  const bytes = rtps.reduce((n, r) => n + (dir === 'outbound' ? r.bytesSent ?? 0 : r.bytesReceived ?? 0), 0);
  const ts = (top.timestamp as number) ?? Date.now();
  const codec = byId.get(top.codecId)?.mimeType?.replace('video/', '') ?? '';
  let rtt: number | null = null;
  const pair = all.find((s) => s.type === 'candidate-pair' && (s.nominated || s.state === 'succeeded') && typeof s.currentRoundTripTime === 'number');
  if (pair) rtt = Math.round(pair.currentRoundTripTime * 1000);
  else {
    const ri = all.find((s) => s.type === 'remote-inbound-rtp' && typeof s.roundTripTime === 'number');
    if (ri) rtt = Math.round(ri.roundTripTime * 1000);
  }
  return {
    sample: { bytes, ts },
    stats: {
      bitrateKbps: prev ? bitrateKbps(prev.bytes, prev.ts, bytes, ts) : 0,
      fps: Math.round(top.framesPerSecond ?? 0),
      width: top.frameWidth ?? 0,
      height: top.frameHeight ?? 0,
      codec,
      rttMs: rtt,
      packetsLost: top.packetsLost,
      qualityLimitation: top.qualityLimitationReason && top.qualityLimitationReason !== 'none' ? top.qualityLimitationReason : undefined,
      layer: top.rid,
    },
  };
}
