import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useVoiceContext } from './context';
import type { ParticipantView, StreamSource, VoiceSnapshot } from '../client';
import type { StreamStats } from '../network';
import { mapVoiceError } from '../errors';

export const useVoiceClient = () => useVoiceContext().client;

export function useVoiceSnapshot(): VoiceSnapshot {
  const { client } = useVoiceContext();
  return useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
}

/** Participants of the current voice room: speaking users first, then by name. */
export function useParticipants(opts: { sort?: boolean } = {}): ParticipantView[] {
  const { participants } = useVoiceSnapshot();
  if (opts.sort === false) return participants;
  return [...participants].sort((a, b) => Number(b.speaking) - Number(a.speaking) || Number(b.isLocal) - Number(a.isLocal) || a.name.localeCompare(b.name));
}

export interface UseVoiceChannelOptions { autoJoin?: boolean; maxRetries?: number }

/**
 * Join/leave a voice channel. Fetches a token via the provider, connects, and re-joins with a fresh token
 * (exponential backoff) if the server drops the session. LiveKit itself handles transient network blips.
 */
export function useVoiceChannel(channelId: string | null, o: UseVoiceChannelOptions = {}) {
  const { client, fetchToken } = useVoiceContext();
  const snap = useVoiceSnapshot();
  const retries = useRef(0);
  const wantRef = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const max = o.maxRetries ?? 5;

  const join = useCallback(async () => {
    if (!channelId) return;
    wantRef.current = channelId;
    try {
      const t = await fetchToken(channelId);
      await client.connect(t, channelId);
      retries.current = 0;
    } catch (e: any) {
      if (e?.code === undefined) client.reportError(e, 'token');
      throw e?.code ? e : mapVoiceError(e, 'token');
    }
  }, [client, fetchToken, channelId]);

  const leave = useCallback(async () => {
    wantRef.current = null; clearTimeout(timer.current);
    await client.disconnect();
  }, [client]);

  useEffect(() => {
    if (snap.status === 'disconnected' && wantRef.current && retries.current < max) {
      const delay = Math.min(30_000, 500 * 2 ** retries.current++);
      timer.current = setTimeout(() => { void join().catch(() => {}); }, delay);
      return () => clearTimeout(timer.current);
    }
  }, [snap.status, join, max]);

  useEffect(() => {
    if (o.autoJoin && channelId) { void join().catch(() => {}); return () => { void leave(); }; }
  }, [channelId, o.autoJoin]); // eslint-disable-line react-hooks/exhaustive-deps

  const joined = snap.channelId === channelId && (snap.status === 'connected' || snap.status === 'reconnecting');
  return {
    join, leave, joined, status: snap.status, error: snap.error, client, snapshot: snap,
    connecting: snap.status === 'connecting',
    reconnecting: snap.status === 'reconnecting',
  };
}

/** Live WebRTC stats for the stats overlay; polls once per `intervalMs` while `enabled`. */
export function useStreamStats(identity: string, source: StreamSource, enabled = true, intervalMs = 1000): StreamStats | null {
  const client = useVoiceClient();
  const [stats, setStats] = useState<StreamStats | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const tick = async () => { try { const s = await client.getStats(identity, source); if (alive) setStats(s); } catch { /* ignore */ } };
    void tick();
    const id = setInterval(tick, intervalMs);
    return () => { alive = false; clearInterval(id); };
  }, [client, identity, source, enabled, intervalMs]);
  return stats;
}

/** Attach a participant's video track to a <video> element ref (adaptiveStream relies on attached elements). */
export function useVideoTrack(identity: string, source: StreamSource) {
  const client = useVoiceClient();
  const snap = useVoiceSnapshot();
  const ref = useRef<HTMLVideoElement | null>(null);
  const p = snap.participants.find((x) => x.identity === identity);
  const present = source === 'camera' ? p?.cameraOn : p?.screenOn;
  useEffect(() => {
    const el = ref.current;
    const track: any = client.getVideoTrack(identity, source);
    if (!el || !track || !present) return;
    track.attach(el);
    el.playsInline = true; el.muted = true; // audio is routed through separate audio elements
    return () => { try { track.detach(el); } catch { /* noop */ } };
  }, [client, identity, source, present, snap.status]);
  return { ref, present: !!present, participant: p };
}

export function useAudioUnlock() {
  const { audioBlocked } = useVoiceSnapshot();
  const client = useVoiceClient();
  return { blocked: audioBlocked, unlock: () => client.unlockAudio() };
}

export function useDevices() {
  const { devices, settings } = useVoiceSnapshot();
  return { ...devices, settings };
}
