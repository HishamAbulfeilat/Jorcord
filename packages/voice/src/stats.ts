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

/** Connection-level health shown in the voice dock ("Voice Connected" tooltip) and the diagnostics panel. */
export interface ConnectionStats {
  rttMs: number | null;
  /** 0..100, over the last sample window (inbound + outbound). */
  packetLossPct: number | null;
  /** Selected ICE path: how media actually flows. */
  transport: 'udp' | 'tcp' | 'relay' | null;
  localCandidate: string | null; remoteCandidate: string | null;
  bitrateInKbps: number; bitrateOutKbps: number;
}
export interface ConnSample { ts: number; recv: number; lost: number; sent: number; bytesIn: number; bytesOut: number }

/** Pure: folds one or two RTCStatsReports (publisher + subscriber) into ConnectionStats given the previous sample. */
export function parseConnectionStats(reports: Iterable<any>[], now: number, prev?: ConnSample): { stats: ConnectionStats; sample: ConnSample } {
  let rtt: number | null = null; let transport: ConnectionStats['transport'] = null; let local: string | null = null; let remote: string | null = null;
  let recv = 0, lost = 0, sent = 0, bytesIn = 0, bytesOut = 0; let remoteLossFrac: number[] = [];
  for (const report of reports) {
    const byId = new Map<string, any>(); const list: any[] = [];
    (report as any).forEach?.((r: any) => { byId.set(r.id, r); list.push(r); });
    for (const r of list) {
      if (r.type === 'candidate-pair' && (r.nominated || r.state === 'succeeded') && r.selected !== false) {
        if (typeof r.currentRoundTripTime === 'number' && r.currentRoundTripTime > 0) rtt = Math.round(r.currentRoundTripTime * 1000);
        const l = byId.get(r.localCandidateId); const rm = byId.get(r.remoteCandidateId);
        if (l && (r.nominated || !local)) {
          const rel = l.candidateType === 'relay' || rm?.candidateType === 'relay';
          transport = rel ? 'relay' : l.protocol === 'tcp' ? 'tcp' : 'udp';
          local = `${l.candidateType ?? '?'} ${l.address ?? l.ip ?? ''}:${l.port ?? ''}`.trim();
          remote = rm ? `${rm.candidateType ?? '?'} ${rm.address ?? rm.ip ?? ''}:${rm.port ?? ''}`.trim() : null;
        }
      } else if (r.type === 'inbound-rtp') { recv += r.packetsReceived ?? 0; lost += Math.max(0, r.packetsLost ?? 0); bytesIn += r.bytesReceived ?? 0; }
      else if (r.type === 'outbound-rtp') { sent += r.packetsSent ?? 0; bytesOut += r.bytesSent ?? 0; }
      else if (r.type === 'remote-inbound-rtp') { if (typeof r.fractionLost === 'number') remoteLossFrac.push(r.fractionLost); if (rtt == null && typeof r.roundTripTime === 'number' && r.roundTripTime > 0) rtt = Math.round(r.roundTripTime * 1000); }
    }
  }
  const sample: ConnSample = { ts: now, recv, lost, sent, bytesIn, bytesOut };
  let loss: number | null = null; let kin = 0, kout = 0;
  if (prev && now > prev.ts) {
    const dRecv = recv - prev.recv; const dLost = lost - prev.lost; const dt = (now - prev.ts) / 1000;
    if (dRecv >= 0 && dLost >= 0 && dRecv + dLost > 0) loss = (dLost / (dRecv + dLost)) * 100;
    if (remoteLossFrac.length) loss = Math.max(loss ?? 0, (Math.max(...remoteLossFrac) / 255) * 100);
    if (bytesIn >= prev.bytesIn) kin = Math.round(((bytesIn - prev.bytesIn) * 8) / dt / 1000);
    if (bytesOut >= prev.bytesOut) kout = Math.round(((bytesOut - prev.bytesOut) * 8) / dt / 1000);
  }
  return { stats: { rttMs: rtt, packetLossPct: loss == null ? null : Math.round(loss * 10) / 10, transport, localCandidate: local, remoteCandidate: remote, bitrateInKbps: kin, bitrateOutKbps: kout }, sample };
}
