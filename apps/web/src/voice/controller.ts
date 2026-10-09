/**
 * Voice controller: one VoiceClient (LiveKit) per tab, joined/left through the API token endpoint and mirrored to the
 * gateway with VOICE_STATE_UPDATE (op 4). UI reads the client via @jorcord/voice/react hooks and `useVoiceUI`.
 */
import { VoiceClient, type StreamPresetId, type VoiceSettings, type VoiceSnapshot, type ContentHint } from '@jorcord/voice';
import { api } from '@/lib/api';
import { getGateway } from '@/lib/gateway';
import { useData, findChannel } from '@/stores/data';
import { useUI, type Prefs } from '@/stores/ui';
import { useVoiceUI, voiceHooks } from '@/stores/voiceui';
import { playSound } from '@/lib/sound';

export function settingsFromPrefs(p: Prefs): Partial<VoiceSettings> {
  return {
    audio: {
      echoCancellation: p.echoCancellation, noiseSuppression: p.noiseSuppression, autoGainControl: p.autoGain,
      noiseSuppressionMode: !p.noiseSuppression ? 'off' : p.noiseEngine === 'off' ? 'off' : p.noiseEngine,
      musicMode: p.musicMode, bitrateKbps: p.voiceBitrate, dtx: true, red: true,
      inputDeviceId: p.inputDevice !== 'default' ? p.inputDevice : undefined,
      outputDeviceId: p.outputDevice !== 'default' ? p.outputDevice : undefined,
    },
    inputMode: p.pushToTalk ? 'ptt' : p.vadMode ? 'vad' : 'open',
    pttCode: p.pttCode, vadThreshold: p.vadThreshold,
    cameraPreset: p.cameraPreset as StreamPresetId, screenPreset: p.screenPreset as StreamPresetId,
    screenHint: p.screenHint, screenAudio: p.screenAudio,
  };
}

let client: VoiceClient | null = null;
let joining: Promise<void> | null = null;
let lastSent = '';
let wantChannel: string | null = null;
let lastSendAt = 0;

export function getVoiceClient(): VoiceClient {
  if (!client) {
    client = new VoiceClient({
      settings: settingsFromPrefs(useUI.getState().prefs),
      onDisconnected: (reason) => {
        // Permanent drop (kicked / room closed / token expired): reflect it everywhere.
        if (reason === 'client' || wantChannel === null) return;
        const ch = wantChannel; wantChannel = null; lastSent = '';
        useVoiceUI.getState().patch({ conn: 'idle', joiningChannelId: null }); useVoiceUI.getState().setConnected(null);
        sendVoiceState(null, undefined);
        useUI.getState().toast(reason === 'server' ? 'You were disconnected from voice.' : 'Lost connection to voice.', 'error');
        void ch;
      },
    });
    bindClient(client);
    (window as any).__jorcordVoice = debugApi(client);
  }
  return client;
}

function channelGuild(channelId: string | null): string | null {
  if (!channelId) return null;
  return findChannel(useData.getState(), channelId)?.guildId ?? null;
}

function sendVoiceState(channelId: string | null, snap: VoiceSnapshot | undefined) {
  lastSendAt = Date.now();
  const payload = { guildId: channelGuild(channelId), channelId, selfMute: snap?.muted ?? false, selfDeaf: snap?.deafened ?? false, video: snap?.cameraOn ?? false, streaming: snap?.screenOn ?? false };
  getGateway().updateVoiceState(payload);
}

function bindClient(c: VoiceClient) {
  let prevStatus = c.getSnapshot().status;
  c.subscribe(() => {
    const s = c.getSnapshot();
    const ui = useVoiceUI.getState();
    const conn = s.status === 'connected' ? 'connected' : s.status === 'connecting' ? 'connecting' : s.status === 'reconnecting' ? 'reconnecting' : ui.conn === 'connecting' && s.status === 'idle' ? 'connecting' : s.status === 'idle' || s.status === 'disconnected' ? (wantChannel ? 'reconnecting' : 'idle') : 'idle';
    if (s.status === 'connected' || s.status === 'reconnecting') {
      if (ui.selfMute !== s.muted || ui.selfDeaf !== s.deafened || ui.conn !== conn) ui.patch({ selfMute: s.muted, selfDeaf: s.deafened, conn });
    }
    if (s.status === 'connected' && wantChannel && s.channelId === wantChannel) {
      const key = `${wantChannel}|${s.muted}|${s.deafened}|${s.cameraOn}|${s.screenOn}`;
      if (key !== lastSent) { lastSent = key; sendVoiceState(wantChannel, s); }
    }
    if (prevStatus !== s.status) {
      if (s.status === 'connected' && prevStatus !== 'reconnecting') playSound('join' as any);
      prevStatus = s.status;
    }
  });
  // After a gateway reconnect with a fresh session, the server forgot our voice state: re-announce.
  getGateway().on('READY', () => { lastSent = ''; const s = c.getSnapshot(); if (wantChannel && s.status === 'connected') { lastSent = `${wantChannel}|${s.muted}|${s.deafened}|${s.cameraOn}|${s.screenOn}`; sendVoiceState(wantChannel, s); } });
  // Server-driven changes to MY voice state: moved by a moderator, or disconnected.
  getGateway().on('VOICE_STATE_UPDATE', (d) => {
    const me = useData.getState().me?.id;
    if (!me || d.userId !== me || !wantChannel || joining || Date.now() - lastSendAt < 2500) return;
    if (!d.channelId) {
      wantChannel = null; lastSent = '';
      const ui = useVoiceUI.getState(); ui.patch({ conn: 'idle', joiningChannelId: null }); ui.setConnected(null);
      void c.disconnect().catch(() => {});
      useUI.getState().toast('You were disconnected from voice.', 'info');
    } else if (d.channelId !== wantChannel) {
      void moveTo(d.channelId);
    }
  });
  voiceHooks.toggleMute = () => { const s = c.getSnapshot(); if (s.deafened) { void c.setDeafened(false); } else void c.setMuted(!s.muted).catch((e) => c.reportError(e)); };
  voiceHooks.toggleDeaf = () => { void c.toggleDeafen(); };
}

async function moveTo(channelId: string) {
  const c = getVoiceClient(); const ui = useVoiceUI.getState();
  wantChannel = channelId; lastSent = '';
  ui.setConnected(channelId); ui.patch({ conn: 'connecting' });
  try {
    const tok = await api.voice.token(channelId);
    await c.connect(tok, channelId);
    const name = findChannel(useData.getState(), channelId)?.name;
    useUI.getState().toast(`You were moved to ${name ?? 'another channel'}.`, 'info');
  } catch (e: any) {
    wantChannel = null; ui.patch({ conn: 'idle' }); ui.setConnected(null);
    useUI.getState().toast(e?.message || 'Could not follow the move.', 'error');
  }
}

export function currentVoiceChannel() { return wantChannel; }

export async function joinVoice(channelId: string) {
  const c = getVoiceClient();
  const ui = useVoiceUI.getState();
  if (wantChannel === channelId && (c.getSnapshot().status === 'connected' || c.getSnapshot().status === 'connecting')) return;
  if (joining) { try { await joining; } catch { /* ignore */ } }
  const run = (async () => {
    const prev = wantChannel;
    if (prev && prev !== channelId) await leaveVoice();
    wantChannel = channelId; lastSent = '';
    ui.patch({ conn: 'connecting', joiningChannelId: channelId }); ui.setConnected(channelId);
    try {
      const tok = await api.voice.token(channelId);
      c.prepare({ muted: ui.selfMute, deafened: ui.selfDeaf });
      await c.connect(tok, channelId);
      if (wantChannel !== channelId) { await c.disconnect(); return; }
      ui.patch({ joiningChannelId: null });
      const s = c.getSnapshot();
      lastSent = `${channelId}|${s.muted}|${s.deafened}|${s.cameraOn}|${s.screenOn}`;
      sendVoiceState(channelId, s);
    } catch (e: any) {
      wantChannel = null; ui.patch({ conn: 'idle', joiningChannelId: null }); ui.setConnected(null);
      try { await c.disconnect(); } catch { /* ignore */ }
      useUI.getState().toast(e?.message || 'Could not join voice.', 'error');
    }
  })();
  joining = run; await run; joining = null;
}

export async function leaveVoice() {
  const c = client; const ch = wantChannel;
  wantChannel = null; lastSent = '';
  const ui = useVoiceUI.getState();
  ui.patch({ conn: 'idle', joiningChannelId: null }); ui.setConnected(null); ui.setFocus(null);
  if (ch) sendVoiceState(null, undefined);
  if (c) { try { await c.disconnect(); } catch { /* ignore */ } }
  if (ch) playSound('leave' as any);
}

/** Apply persisted preferences to a live client. */
export function applyPrefs(p: Prefs) {
  if (!client) return;
  const s = settingsFromPrefs(p); const cur = client.getSnapshot().settings;
  const a = s.audio!; const ca = cur.audio;
  const audioKeys = ['echoCancellation', 'noiseSuppression', 'autoGainControl', 'noiseSuppressionMode', 'musicMode', 'bitrateKbps'] as const;
  const patch: any = {};
  for (const k of audioKeys) if (a[k] !== ca[k]) patch[k] = a[k];
  if (Object.keys(patch).length) void client.setAudioSettings(patch).catch(() => {});
  if (a.inputDeviceId !== ca.inputDeviceId && a.inputDeviceId) void client.setInputDevice(a.inputDeviceId).catch(() => {});
  if (a.outputDeviceId !== ca.outputDeviceId && a.outputDeviceId) void client.setOutputDevice(a.outputDeviceId).catch(() => {});
  if (s.inputMode !== cur.inputMode) client.setInputMode(s.inputMode!);
  if (s.pttCode !== cur.pttCode) client.setPttKey(s.pttCode!);
  if (s.vadThreshold !== cur.vadThreshold) client.setVadThreshold(s.vadThreshold!);
}

export function startScreenShare(o: { preset: StreamPresetId; hint: ContentHint; audio: boolean }) {
  const c = getVoiceClient();
  useUI.getState().setPref('screenPreset', o.preset as Prefs['screenPreset']);
  useUI.getState().setPref('screenHint', o.hint as 'motion' | 'detail');
  useUI.getState().setPref('screenAudio', o.audio);
  return c.startScreenShare(o).catch((e) => { if (e?.code !== 'screen-cancelled') useUI.getState().toast(e?.message ?? 'Could not start screen share', 'error'); });
}

/** Test/debug surface (Playwright asserts on this). Not part of the public UI. */
function debugApi(c: VoiceClient) {
  const room = c.room;
  const pubInfo = (pub: any) => pub && {
    sid: pub.trackSid, source: pub.source, kind: pub.kind, subscribed: !!pub.isSubscribed, muted: !!pub.isMuted,
    width: pub.dimensions?.width ?? 0, height: pub.dimensions?.height ?? 0, hasTrack: !!pub.track,
  };
  return {
    client: c, room,
    state: () => { const s = c.getSnapshot(); return { status: s.status, channelId: s.channelId, muted: s.muted, deafened: s.deafened, cameraOn: s.cameraOn, screenOn: s.screenOn, error: s.error?.code ?? null, participants: s.participants.map((p) => ({ identity: p.identity, name: p.name, isLocal: p.isLocal, speaking: p.speaking, micMuted: p.micMuted, cameraOn: p.cameraOn, screenOn: p.screenOn })) }; },
    remotes: () => [...room.remoteParticipants.values()].map((p) => ({
      identity: p.identity,
      tracks: [...p.trackPublications.values()].map(pubInfo),
      audioSubscribed: [...p.trackPublications.values()].some((t: any) => t.kind === 'audio' && t.source === 'microphone' && t.isSubscribed && t.track),
      cameraSubscribed: [...p.trackPublications.values()].some((t: any) => t.source === 'camera' && t.isSubscribed && t.track),
      screenSubscribed: [...p.trackPublications.values()].some((t: any) => t.source === 'screen_share' && t.isSubscribed && t.track),
    })),
    /** inbound audio RTP stats for a remote participant (bytes>0 means audio is flowing). */
    audioStats: async (identity: string) => {
      const p: any = room.remoteParticipants.get(identity);
      const t: any = p?.getTrackPublication('microphone')?.track;
      const rep = t?.receiver ? await t.receiver.getStats() : null;
      if (!rep) return null;
      let out: any = null; rep.forEach((r: any) => { if (r.type === 'inbound-rtp' && r.kind === 'audio') out = { bytesReceived: r.bytesReceived, packetsReceived: r.packetsReceived, audioLevel: r.audioLevel, totalAudioEnergy: r.totalAudioEnergy }; });
      return out;
    },
    stats: (identity: string, source: 'camera' | 'screen') => c.getStats(identity, source),
    /** Settings of my own capture track (what getDisplayMedia actually delivered) + the preset in use. */
    localTrack: (source: 'camera' | 'screen') => {
      const t: any = c.getVideoTrack(room.localParticipant.identity, source);
      const st = t?.mediaStreamTrack?.getSettings?.();
      return st ? { width: st.width, height: st.height, frameRate: st.frameRate, preset: c.getSnapshot().settings.screenPreset, codec: c.getSnapshot().activeCodec } : null;
    },
    /** Decoded media element dimensions of the on-screen video tile. */
    tileVideo: (identity: string, source: 'camera' | 'screen') => {
      const el = document.querySelector<HTMLVideoElement>(`[data-tile="${identity}:${source}"] video`);
      return el ? { videoWidth: el.videoWidth, videoHeight: el.videoHeight, paused: el.paused, readyState: el.readyState } : null;
    },
  };
}

export const isDmChannel = (channelId: string) => { const ch = findChannel(useData.getState(), channelId); return ch?.type === 'dm' || ch?.type === 'group_dm'; };
