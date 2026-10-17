/**
 * Smoke test: two headless clients (@livekit/rtc-node) join a room on a running livekit-server,
 * A publishes a synthetic audio (440Hz sine) + video (gradient) track, B must receive both and
 * decode non-trivial frames. Also exercises server.ts grants and RoomServiceClient.
 *   infra/livekit/bin/livekit-server --config infra/livekit/livekit.yaml &
 *   pnpm --filter @jorcord/voice smoke
 */
import { Room, RoomEvent, TrackKind, AudioSource, AudioStream, LocalAudioTrack, LocalVideoTrack, VideoSource, VideoStream, VideoFrame, AudioFrame, TrackSource, TrackPublishOptions, VideoBufferType } from '@livekit/rtc-node';
import { RoomServiceClient } from 'livekit-server-sdk';
import { mintToken } from '../src/server';

const HTTP = process.env.LK_HTTP ?? 'http://127.0.0.1:7880';
const WS = process.env.LK_URL ?? 'ws://127.0.0.1:7880';
const key = process.env.LK_KEY ?? 'devkey', secret = process.env.LK_SECRET ?? 'secret';
const room = `smoke-${Date.now()}`;
const W = 1280, H = 720;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function fail(m: string): never { console.error('FAIL:', m); process.exit(1); }

async function main() {
  const tokA = await mintToken({ apiKey: key, apiSecret: secret, identity: 'alice', name: 'Alice', room, canPublish: true });
  const tokB = await mintToken({ apiKey: key, apiSecret: secret, identity: 'bob', name: 'Bob', room, canPublish: true });
  const a = new Room(), b = new Room();
  await a.connect(WS, tokA, { autoSubscribe: true, dynacast: true });
  await b.connect(WS, tokB, { autoSubscribe: true, dynacast: true });
  console.log('both connected; remote of B:', [...b.remoteParticipants.keys()]);

  // B listens
  let audioRms = 0, audioFrames = 0, videoFrames = 0, vw = 0, vh = 0, nonFlat = false;
  b.on(RoomEvent.TrackSubscribed, async (track, _pub, p) => {
    console.log('B subscribed', TrackKind[track.kind!], 'from', p.identity);
    if (track.kind === TrackKind.KIND_AUDIO) {
      for await (const f of new AudioStream(track)) {
        audioFrames++; let s = 0; for (const v of f.data) s += v * v; audioRms = Math.max(audioRms, Math.sqrt(s / f.data.length));
        if (audioFrames > 100) break;
      }
    } else {
      for await (const ev of new VideoStream(track)) {
        videoFrames++; vw = ev.frame.width; vh = ev.frame.height;
        const d = ev.frame.convert(VideoBufferType.RGBA).data;
        if (d[0] !== d[d.length - 8]) nonFlat = true;
        if (videoFrames > 30) break;
      }
    }
  });

  // A publishes
  const asrc = new AudioSource(48000, 1);
  const atrack = LocalAudioTrack.createAudioTrack('mic', asrc);
  await a.localParticipant!.publishTrack(atrack, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
  const vsrc = new VideoSource(W, H);
  const vtrack = LocalVideoTrack.createVideoTrack('screen', vsrc);
  await a.localParticipant!.publishTrack(vtrack, new TrackPublishOptions({ source: TrackSource.SOURCE_SCREENSHARE, simulcast: true }));

  let phase = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 6000 && !(audioFrames > 100 && videoFrames > 30)) {
    const samples = new Int16Array(480);
    for (let i = 0; i < 480; i++) samples[i] = Math.round(12000 * Math.sin(2 * Math.PI * 440 * (phase++ / 48000)));
    await asrc.captureFrame(new AudioFrame(samples, 48000, 1, 480));
    const buf = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) { const o = (y * W + x) * 4; buf[o] = (x + phase / 10) & 255; buf[o + 1] = y & 255; buf[o + 2] = 128; buf[o + 3] = 255; }
    vsrc.captureFrame(new VideoFrame(buf, W, H, VideoBufferType.RGBA));
    await sleep(10);
  }

  const svc = new RoomServiceClient(HTTP, key, secret);
  const parts = await svc.listParticipants(room);
  console.log('server sees participants:', parts.map((p) => `${p.identity}[${p.tracks.map((t) => t.source + ':' + t.type).join(',')}]`));
  console.log(`audio: frames=${audioFrames} peakRMS=${audioRms.toFixed(0)}  video: frames=${videoFrames} ${vw}x${vh} nonFlat=${nonFlat}`);

  await a.disconnect(); await b.disconnect();
  if (parts.length !== 2) fail('server did not list 2 participants');
  if (audioFrames < 50 || audioRms < 1000) fail('audio did not round-trip');
  if (videoFrames < 10 || vw === 0 || !nonFlat) fail('video did not round-trip');
  console.log('SMOKE OK: two clients connected, audio + video tracks round-tripped');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
