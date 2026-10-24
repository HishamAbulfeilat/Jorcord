/**
 * Voice controller: one VoiceClient (LiveKit) per tab, joined/left through the API token endpoint and mirrored to the
 * gateway with VOICE_STATE_UPDATE (op 4). UI reads the client via @jorcord/voice/react hooks and `useVoiceUI`.
 */
import { VoiceClient, createNativeScreenSource, mapVoiceError, type StreamPresetId, type VoiceSettings, type VoiceSnapshot, type ContentHint, type VoiceError } from '@jorcord/voice';
import { api } from '@/lib/api';
import { getGateway } from '@/lib/gateway';
import { useData, findChannel } from '@/stores/data';
import { useUI, type Prefs } from '@/stores/ui';
import { useVoiceUI, voiceHooks } from '@/stores/voiceui';
import { useLiveVoice } from '@/stores/livevoice';
import { playSound } from '@/lib/sound';
import { callService, screenSharePlugin } from '@/lib/native';
import { CallRecorder, type RecordingRoom } from './callRecorder';
import { t } from '@/i18n';
import './noiseSetup';
import { audioMapsForClient } from './userAudio';
import { tauriPttSource } from '@/lib/globalPtt';

export function settingsFromPrefs(p: Prefs): Partial<VoiceSettings> {
  return {
    audio: {
      echoCancellation: p.echoCancellation, noiseSuppression: p.noiseSuppression, autoGainControl: p.autoGain,
      noiseSuppressionMode: !p.noiseSuppression ? 'off' : p.noiseEngine,
      musicMode: p.musicMode, bitrateKbps: p.voiceBitrate, dtx: true, red: true,
      inputDeviceId: p.inputDevice !== 'default' ? p.inputDevice : undefined,
      outputDeviceId: p.outputDevice !== 'default' ? p.outputDevice : undefined,
    },
    inputMode: p.pushToTalk ? 'ptt' : p.vadMode ? 'vad' : 'open',
    pttCode: p.pttCode, vadThreshold: p.vadThreshold,
    cameraPreset: p.cameraPreset as StreamPresetId, screenPreset: p.screenPreset as StreamPresetId,
    cameraQuality: p.videoQuality, cameraFps: p.videoFps,
    screenHint: p.screenHint, screenAudio: p.screenAudio,
    mutedSpeakingHint: p.mutedSpeakingHint,
  };
}

const TOKEN_TIMEOUT_MS = 10_000;
const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> => new Promise((res, rej) => {
  const t = setTimeout(() => rej(Object.assign(new Error('The server did not answer in time.'), { name: 'TokenTimeout' })), ms);
  p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
});

/** Normalise whatever a failed join threw (VoiceError from the client, ApiException from the token call) for the UI. */
function failureOf(channelId: string, e: any) {
  // client.connect() throws plain VoiceError objects; anything that is an Error came from the token request (API / timeout / network).
  const ve: VoiceError = e instanceof Error ? { ...mapVoiceError(e, 'token'), message: e.message || 'Could not get a voice token.' } : (e as VoiceError);
  return { channelId, code: ve.code ?? 'unknown', message: ve.message ?? 'Could not join voice.', hint: ve.hint, at: Date.now() };
}

let client: VoiceClient | null = null;
let joining: Promise<void> | null = null;
let lastSent = '';
let wantChannel: string | null = null;
let lastSendAt = 0;
/** The local call recorder (null when this tab is not the one recording). */
let callRecorder: CallRecorder | null = null;
let recordingChannel: string | null = null;
let stoppingRecording: Promise<void> | null = null;

/** Desktop only: register/unregister the OS-wide push-to-talk hotkey when the pref or the key changes. */
let globalPttKey = '';
function syncGlobalPtt(p: Prefs) {
  if (!client) return;
  const key = p.pushToTalk && p.pttGlobal ? p.pttCode : '';
  if (key === globalPttKey) return;
  globalPttKey = key;
  client.setGlobalPttSource(key ? tauriPttSource(key) : undefined);
}

export function getVoiceClient(): VoiceClient {
  if (!client) {
    client = new VoiceClient({
      settings: settingsFromPrefs(useUI.getState().prefs),
      // LiveKit resumes by itself; when it cannot, the client rejoins with a fresh token (backoff, attempt count in the snapshot).
      getToken: (id) => withTimeout(api.voice.token(id), TOKEN_TIMEOUT_MS),
      onConnectionLost: () => { if (wantChannel) playSound('lost'); },
      onReconnected: () => {
        // The server may have cleared our voice state while we were away (LiveKit webhook after the grace period): re-announce.
        const s = client!.getSnapshot();
        if (wantChannel && s.channelId === wantChannel) { lastSent = `${wantChannel}|${s.muted}|${s.deafened}|${s.cameraOn}|${s.screenOn}`; sendVoiceState(wantChannel, s); }
        playSound('restored');
      },
      onDisconnected: (why) => (why === 'error' ? giveUp() : scheduleReconcile()),
    });
    bindClient(client);
    syncGlobalPtt(useUI.getState().prefs);
    { const ua = audioMapsForClient(useUI.getState().prefs); client.syncUserAudio(ua.volumes, ua.muted); }
    // Mobile apps: screen sharing through the native plugin (the button stays hidden when it reports unsupported).
    const sp = screenSharePlugin();
    if (sp) void client.setNativeScreenSource(createNativeScreenSource(sp));
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
    if (conn === 'reconnecting' && s.status === 'reconnecting' && ui.connectingSince === null) ui.patch({ connectingSince: Date.now() });
    // the client gave up (or was closed) while the UI still says "reconnecting": that banner would never go away
    if ((s.status === 'idle' || s.status === 'disconnected') && ui.conn === 'reconnecting' && !joining) ui.patch({ conn: 'idle', connectingSince: null });
    if (ui.streaming !== s.screenOn) ui.patch({ streaming: s.screenOn });
    if (ui.speakingWhileMuted !== s.speakingWhileMuted) ui.patch({ speakingWhileMuted: s.speakingWhileMuted });
    if (s.status === 'connected' || s.status === 'reconnecting') {
      if (ui.selfMute !== s.muted || ui.selfDeaf !== s.deafened || ui.conn !== conn) ui.patch({ selfMute: s.muted, selfDeaf: s.deafened, conn });
    }
    if (s.status === 'connected' && wantChannel && s.channelId === wantChannel) {
      const key = `${wantChannel}|${s.muted}|${s.deafened}|${s.cameraOn}|${s.screenOn}`;
      if (key !== lastSent) { lastSent = key; sendVoiceState(wantChannel, s); }
    }
    if (prevStatus !== s.status) {
      if (s.status === 'connected') { syncPrioritySpeakers(c, wantChannel, useData.getState().voiceStates); syncStreamAudience(c, wantChannel); }
      if (s.status === 'connected' && prevStatus !== 'reconnecting') playSound('join');
      prevStatus = s.status;
    }
  });
  // priority speakers come from the server's voice states, not from participant attributes anyone could write
  useData.subscribe((st, prev) => { if (st.voiceStates !== prev.voiceStates) { syncPrioritySpeakers(c, wantChannel, st.voiceStates); syncStreamAudience(c, wantChannel); } });
  useLiveVoice.subscribe((st, prev) => { if (st.kicked !== prev.kicked) syncStreamAudience(c, wantChannel); });
  // After a gateway reconnect with a fresh session, the server forgot our voice state: re-announce.
  getGateway().on('READY', () => { lastSent = ''; const s = c.getSnapshot(); if (wantChannel && s.status === 'connected') { lastSent = `${wantChannel}|${s.muted}|${s.deafened}|${s.cameraOn}|${s.screenOn}`; sendVoiceState(wantChannel, s); } });
  // Server-driven changes to MY voice state: moved by a moderator, or disconnected.
  getGateway().on('VOICE_STATE_UPDATE', (d) => {
    const me = useData.getState().me?.id;
    if (!me || d.userId !== me || !wantChannel || joining || Date.now() - lastSendAt < 2500) return;
    scheduleReconcile();
  });
  // A moderator can stop the server session: never keep capturing after the indicator is gone.
  getGateway().on('VOICE_RECORDING_UPDATE', (d) => {
    if (d.recording || !recordingChannel || d.channelId !== recordingChannel || stoppingRecording) return;
    const recorder = callRecorder;
    callRecorder = null; recordingChannel = null;
    recorder?.cancel();
    useUI.getState().toast(t('The recording was stopped.'), 'info');
  });
  voiceHooks.toggleMute = () => { const s = c.getSnapshot(); if (s.deafened) { void c.setDeafened(false); } else void c.setMuted(!s.muted).catch((e) => c.reportError(e)); };
  voiceHooks.toggleDeaf = () => { void c.toggleDeafen(); };
}

async function moveTo(channelId: string) {
  const c = getVoiceClient(); const ui = useVoiceUI.getState();
  const moved = wantChannel !== channelId;
  wantChannel = channelId; lastSent = '';
  ui.setConnected(channelId); ui.patch({ conn: 'connecting' });
  try {
    const tok = await api.voice.token(channelId);
    await c.connect(tok, channelId);
    const name = findChannel(useData.getState(), channelId)?.name;
    if (moved) useUI.getState().toast(`You were moved to ${name ?? 'another channel'}.`, 'info');
  } catch (e: any) {
    wantChannel = null; ui.patch({ conn: 'idle', failure: failureOf(channelId, e), connectingSince: null }); ui.setConnected(null);
    useUI.getState().toast(e?.message || 'Could not follow the move.', 'error');
  }
}

let settle: ReturnType<typeof setTimeout> | undefined;
/**
 * The server and LiveKit tell us about moves/kicks in several racing events (room removal, state clear, state set).
 * Wait for them to settle, then compare the gateway's view of my voice state with what we are connected to.
 */
function scheduleReconcile() {
  clearTimeout(settle);
  settle = setTimeout(() => {
    const c = client; const me = useData.getState().me?.id;
    if (!c || !me || !wantChannel || joining) return;
    const st = useData.getState().voiceStates[me]; const status = c.getSnapshot().status;
    // Mid-recovery the server may have dropped our state (LiveKit webhook after the grace period). The client re-announces once it is back.
    if (status === 'reconnecting') { scheduleReconcile(); return; }
    if (!st?.channelId) {
      discardCallRecording();
      wantChannel = null; lastSent = '';
      const ui = useVoiceUI.getState(); ui.patch({ conn: 'idle', joiningChannelId: null }); ui.setConnected(null);
      void c.disconnect().catch(() => {});
      useUI.getState().toast(t('You were disconnected from voice.'), 'info');
    } else if (st.channelId !== wantChannel || status === 'disconnected' || status === 'idle') void moveTo(st.channelId);
  }, 900);
}

function channelLabel(channelId: string) {
  const ch = findChannel(useData.getState(), channelId);
  return ch?.guildId ? `#${ch.name ?? 'voice'}` : (ch?.name ?? 'Call');
}

/** "Go Live" entry point: join the voice channel if needed, then open the stream-quality popover. */
export async function goLive(channelId?: string) {
  const ui = useVoiceUI.getState();
  const target = channelId ?? ui.connectedChannelId;
  if (!target) return;
  if (ui.connectedChannelId !== target || ui.conn === 'idle') await joinVoice(target);
  if (useVoiceUI.getState().conn === 'idle') return;
  useVoiceUI.getState().setSharePop(true);
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
    ui.patch({ conn: 'connecting', joiningChannelId: channelId, failure: null, connectingSince: Date.now() }); ui.setConnected(channelId);
    try {
      const tok = await withTimeout(api.voice.token(channelId), TOKEN_TIMEOUT_MS);
      if (wantChannel !== channelId) return; // cancelled while fetching the token
      c.prepare({ muted: ui.selfMute, deafened: ui.selfDeaf });
      await c.connect(tok, channelId);
      if (wantChannel !== channelId) { await c.disconnect(); return; }
      ui.patch({ joiningChannelId: null, connectingSince: null });
      callService.start(`Voice: ${channelLabel(channelId)}`, false);
      const s = c.getSnapshot();
      lastSent = `${channelId}|${s.muted}|${s.deafened}|${s.cameraOn}|${s.screenOn}`;
      sendVoiceState(channelId, s);
    } catch (e: any) {
      const cancelled = wantChannel !== channelId; // user pressed Cancel / left
      wantChannel = cancelled ? wantChannel : null;
      try { await c.disconnect(); } catch { /* ignore */ }
      if (cancelled) return;
      ui.patch({ conn: 'idle', joiningChannelId: null, connectingSince: null, failure: failureOf(channelId, e) }); ui.setConnected(null);
      // the channel view shows the reason with Retry + Troubleshoot; the toast covers the case where you navigated away
      useUI.getState().toast(e?.message || 'Could not join voice.', 'error');
    }
  })();
  joining = run; await run; joining = null;
}

/** Stop and discard the local take when the call itself is gone (a lost connection cannot upload it). */
function discardCallRecording() {
  callRecorder?.cancel();
  callRecorder = null; recordingChannel = null;
}

/** Every automatic retry failed (or the token was refused): clear the gateway voice state and tell the user why. */
function giveUp() {
  const ch = wantChannel; if (!ch) return;
  const c = client; const err = c?.getSnapshot().error;
  discardCallRecording();
  wantChannel = null; lastSent = '';
  const ui = useVoiceUI.getState();
  ui.patch({ conn: 'idle', joiningChannelId: null, connectingSince: null, failure: { channelId: ch, code: err?.code ?? 'connection', message: err?.message ?? t('Lost connection to voice.'), hint: err?.hint, at: Date.now() } });
  ui.setConnected(null); ui.setFocus(null);
  sendVoiceState(null, undefined); callService.stop();
  playSound('leave');
  void c?.disconnect().catch(() => {});
  useUI.getState().toast(t('Lost connection to voice.'), 'error');
}

/** "Retry" in the Troubleshoot panel / reconnect banner. */
export function retryVoice() {
  const ui = useVoiceUI.getState();
  const c = client;
  if (c && c.getSnapshot().status === 'reconnecting') { c.retry(); return; }
  const ch = ui.failure?.channelId ?? ui.connectedChannelId;
  if (ch) void joinVoice(ch);
}

export type CallRecordingMode = 'audio' | 'video';

/**
 * Start the server-owned recording indicator, then capture locally: every participant's audio (plus the
 * active screen share in video mode) is mixed into one MediaRecorder take. The server enforces RECORD_VOICE.
 */
export async function startCallRecording(channelId: string, mode: CallRecordingMode) {
  if (callRecorder || recordingChannel) return;
  if (useData.getState().voiceRecordings[channelId]) {
    useUI.getState().toast(t('This channel is already being recorded.'), 'error');
    return;
  }
  let startedOnServer = false;
  try {
    const { recording } = await api.voice.recordingStart(channelId);
    startedOnServer = true;
    useData.getState().apply('VOICE_RECORDING_UPDATE', { channelId, recording });
    const recorder = new CallRecorder({ onLimit: (reason) => { void stopCallRecording({ reason }); } });
    await recorder.start(getVoiceClient().room as unknown as RecordingRoom, { video: mode === 'video' });
    callRecorder = recorder;
    recordingChannel = channelId;
    useUI.getState().toast(t('Recording started.'), 'success');
  } catch (e: any) {
    // A session that did start on the server must not stay marked as recording when local capture failed.
    if (startedOnServer) {
      await api.voice.recordingStop(channelId).catch(() => {});
      useData.getState().apply('VOICE_RECORDING_UPDATE', { channelId, recording: null });
    }
    useUI.getState().toast(e?.message || t('Could not start recording.'), 'error');
  }
}

/** Stop the local take, upload it, and let the server post it as an attachment while clearing the indicator. */
export function stopCallRecording(opts: { silent?: boolean; reason?: 'time' | 'size' } = {}): Promise<void> {
  if (stoppingRecording) return stoppingRecording;
  const recorder = callRecorder;
  const channelId = recordingChannel;
  if (!recorder && !channelId) return Promise.resolve();
  const run = (async () => {
    const file = recorder ? await recorder.stop().catch(() => null) : null;
    callRecorder = null; recordingChannel = null;

    let attachments: string[] | undefined;
    if (file) {
      try { attachments = [(await api.files.upload(file)).id]; }
      catch (e: any) { useUI.getState().toast(e?.message || t('Could not upload the recording.'), 'error'); }
    }
    if (channelId) {
      try {
        await api.voice.recordingStop(channelId, attachments);
        useData.getState().apply('VOICE_RECORDING_UPDATE', { channelId, recording: null });
      } catch (e: any) {
        useUI.getState().toast(e?.message || t('Could not stop recording.'), 'error');
      }
    }

    if (!opts.silent) {
      if (opts.reason === 'time') useUI.getState().toast(t('Recording stopped at the 2-hour limit.'), 'info');
      else if (opts.reason === 'size') useUI.getState().toast(t('Recording stopped at the upload size limit.'), 'info');
      else if (attachments) useUI.getState().toast(t('Recording posted in the channel.'), 'success');
    }
  })();
  stoppingRecording = run.finally(() => { stoppingRecording = null; });
  return stoppingRecording;
}

export async function leaveVoice() {
  const c = client; const ch = wantChannel;
  // Finish and post the current take while we are still in the channel (the stop endpoint requires membership).
  await stopCallRecording({ silent: true });
  wantChannel = null; lastSent = '';
  const ui = useVoiceUI.getState();
  ui.patch({ conn: 'idle', joiningChannelId: null, connectingSince: null, failure: null }); ui.setConnected(null); ui.setFocus(null);
  if (ch) { sendVoiceState(null, undefined); callService.stop(); useLiveVoice.getState().clearChannel(ch); }
  if (c) { try { await c.disconnect(); } catch { /* ignore */ } }
  if (ch) playSound('leave');
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
  const ua = audioMapsForClient(p); client.syncUserAudio(ua.volumes, ua.muted);
  if (s.inputMode !== cur.inputMode) client.setInputMode(s.inputMode!);
  if (s.pttCode !== cur.pttCode) client.setPttKey(s.pttCode!);
  syncGlobalPtt(p);
  if (s.vadThreshold !== cur.vadThreshold) client.setVadThreshold(s.vadThreshold!);
  if (s.mutedSpeakingHint !== cur.mutedSpeakingHint) client.setMutedSpeakingHint(!!s.mutedSpeakingHint);
  if (s.cameraQuality !== cur.cameraQuality || s.cameraFps !== cur.cameraFps) {
    void client.setCameraSettings({ quality: s.cameraQuality, fps: s.cameraFps }).catch(() => {});
  }
}

export function startScreenShare(o: { preset: StreamPresetId; hint: ContentHint; audio: boolean }) {
  const c = getVoiceClient();
  useUI.getState().setPref('screenPreset', o.preset as Prefs['screenPreset']);
  useUI.getState().setPref('screenHint', o.hint as 'motion' | 'detail');
  useUI.getState().setPref('screenAudio', o.audio);
  return c.startScreenShare(o).catch((e) => { if (e?.code !== 'screen-cancelled') useUI.getState().toast(e?.message ?? 'Could not start screen share', 'error'); });
}

/**
 * Priority speaker: the server authorises it (PRIORITY_SPEAKER, only while connected and able to speak), stores it in my voice state
 * and broadcasts it; every client then ducks the others from the voice states (see `syncPrioritySpeakers`). Off is always allowed.
 */
export function setPrioritySpeaker(on: boolean) {
  const ch = wantChannel ?? useVoiceUI.getState().connectedChannelId;
  if (!ch) return;
  void api.voice.prioritySpeaker(ch, on)
    .then((r) => { if (r.voiceState) useData.getState().apply('VOICE_STATE_UPDATE', r.voiceState); })
    .catch((e) => useUI.getState().toast(e?.message || 'Could not change priority speaker', 'error'));
}

/**
 * Go Live, streamer side: once I cap my audience or have removed someone, only the viewers the server accepted may receive my
 * screen share (the media-level half of the cap and of "remove viewer"). Without either, everyone in the call may watch.
 */
export function syncStreamAudience(c: VoiceClient, channelId: string | null) {
  const me = useData.getState().me?.id; const states = useData.getState().voiceStates;
  const mine = me ? states[me] : undefined;
  if (!channelId || !me || !mine?.streaming || mine.channelId !== channelId) { c.setStreamAudience(null); return; }
  const kicked = useLiveVoice.getState().kicked[`${channelId}:${me}`] ?? [];
  if (mine.streamViewerLimit == null && !kicked.length) { c.setStreamAudience(null); return; }
  c.setStreamAudience(Object.values(states).filter((v) => v.channelId === channelId && v.watching === me && !kicked.includes(v.userId)).map((v) => v.userId));
}

/** Tell the client which participants the server says hold priority speaker (their identity is their user id). */
export function syncPrioritySpeakers(c: VoiceClient, channelId: string | null, states: Record<string, { channelId: string | null; prioritySpeaker?: boolean }>) {
  c.setPrioritySpeakers(channelId ? Object.entries(states).filter(([, v]) => v.channelId === channelId && v.prioritySpeaker).map(([id]) => id) : []);
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
    state: () => { const s = c.getSnapshot(); return { status: s.status, channelId: s.channelId, muted: s.muted, deafened: s.deafened, cameraOn: s.cameraOn, screenOn: s.screenOn, speakingWhileMuted: s.speakingWhileMuted, error: s.error?.code ?? null, participants: s.participants.map((p) => ({ identity: p.identity, name: p.name, isLocal: p.isLocal, speaking: p.speaking, micMuted: p.micMuted, cameraOn: p.cameraOn, screenOn: p.screenOn, priority: p.priority })) }; },
    /** noise suppression as applied to the published mic (e2e): the setting, the processor on the track, and any fallback. */
    noise: () => { const mic: any = room.localParticipant.getTrackPublication('microphone' as any)?.track; return { ...c.getSnapshot().noise, processor: mic?.getProcessor?.()?.name ?? null }; },
    setNoise: (m: Prefs['noiseEngine']) => { const st = useUI.getState(); st.setPref('noiseSuppression', m !== 'off'); st.setPref('noiseEngine', m); },
    userVolume: (id: string) => c.getUserVolume(id), userMuted: (id: string) => c.isUserMuted(id),
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
      const s = c.getSnapshot().settings;
      return st ? { width: st.width, height: st.height, frameRate: st.frameRate, preset: source === 'camera' ? s.cameraQuality : s.screenPreset, codec: c.getSnapshot().activeCodec } : null;
    },
    /** Decoded media element dimensions of the on-screen video tile. */
    tileVideo: (identity: string, source: 'camera' | 'screen') => {
      const el = document.querySelector<HTMLVideoElement>(`[data-tile="${identity}:${source}"] video`);
      return el ? { videoWidth: el.videoWidth, videoHeight: el.videoHeight, paused: el.paused, readyState: el.readyState } : null;
    },
  };
}

export const isDmChannel = (channelId: string) => { const ch = findChannel(useData.getState(), channelId); return ch?.type === 'dm' || ch?.type === 'group_dm'; };
