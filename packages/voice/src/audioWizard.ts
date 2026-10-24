import type { AudioSettings } from './audio';
import type { ConnectionStats } from './stats';
import { applyNoiseStrength } from './noiseTuning';

/**
 * "Audio problem? Run diagnostics": pure analysis behind the wizard. The UI records short clips (mic level, a loopback echo test),
 * hands the raw samples here and shows the suggested fixes. No audio ever leaves the device.
 */

// ---------------------------------------------------------------- levels
export interface MicLevels {
  /** dBFS RMS of the quietest ~10-25% of 50 ms windows: the room/mic noise floor. */
  noiseFloorDb: number;
  /** dBFS RMS of the loudest windows: how loud you speak. */
  speechDb: number;
  peakDb: number;
  /** Share of samples at or near full scale (0..100). */
  clippedPct: number;
}

const toDb = (x: number) => (x > 1e-9 ? 20 * Math.log10(x) : -120);

/** Analyse one clip: expects the user to stay quiet for a moment and then speak. */
export function measureMic(samples: Float32Array, sampleRate: number): MicLevels {
  const win = Math.max(1, Math.round(sampleRate * 0.05));
  const rms: number[] = []; let peak = 0, clipped = 0;
  for (let i = 0; i + win <= samples.length; i += win) {
    let s = 0;
    for (let j = i; j < i + win; j++) { const v = samples[j]!; s += v * v; const a = Math.abs(v); if (a > peak) peak = a; if (a >= 0.985) clipped++; }
    rms.push(Math.sqrt(s / win));
  }
  if (!rms.length) return { noiseFloorDb: -120, speechDb: -120, peakDb: -120, clippedPct: 0 };
  const sorted = [...rms].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return { noiseFloorDb: toDb(at(0.15)), speechDb: toDb(at(0.92)), peakDb: toDb(peak), clippedPct: Math.round((clipped / Math.max(1, rms.length * win)) * 10_000) / 100 };
}

// ---------------------------------------------------------------- echo
/** Beep pattern played through the speakers during the echo test: distinctive envelope, easy to find in a recording. */
export function makeEchoTestSignal(sampleRate: number): Float32Array {
  // 880 Hz bursts: 120 ms on, with gaps of 100 / 200 / 100 / 300 ms (irregular on purpose, so a lone noise burst cannot match)
  const gaps = [100, 200, 100, 300, 150]; const out: number[] = [];
  const burst = Math.round(sampleRate * 0.12);
  for (const g of gaps) {
    for (let i = 0; i < burst; i++) { const env = Math.min(1, i / 120, (burst - i) / 120); out.push(0.5 * env * Math.sin((2 * Math.PI * 880 * i) / sampleRate)); }
    for (let i = 0; i < Math.round((sampleRate * g) / 1000); i++) out.push(0);
  }
  return Float32Array.from(out);
}

function envelope(x: Float32Array, sampleRate: number, stepMs = 10): Float64Array {
  const step = Math.max(1, Math.round((sampleRate * stepMs) / 1000)); const n = Math.floor(x.length / step); const e = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < step; j++) { const v = x[i * step + j]!; s += v * v; } e[i] = Math.sqrt(s / step); }
  return e;
}

export interface EchoResult {
  /** Normalised envelope correlation at the best delay (0..1). */
  correlation: number;
  /** Delay between playing and hearing it back. */
  lagMs: number;
  /** Level of the played signal as picked up by the mic, dBFS RMS during the beeps. */
  pickedUpDb: number;
  detected: boolean;
}

/**
 * Does the microphone hear what the speakers play? Cross-correlates the loudness envelopes of the played test signal and the
 * recording over delays up to `maxLagMs`. Record with echo cancellation OFF to measure the physical path; with it on the browser
 * removes the echo and a "not detected" result only says the canceller works.
 */
export function detectEcho(played: Float32Array, recorded: Float32Array, sampleRate: number, maxLagMs = 600): EchoResult {
  const a = envelope(played, sampleRate), b = envelope(recorded, sampleRate);
  const maxLag = Math.min(b.length - 1, Math.round(maxLagMs / 10));
  const meanA = a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
  let best = 0, bestLag = 0;
  for (let lag = 0; lag <= maxLag; lag++) {
    const n = Math.min(a.length, b.length - lag); if (n < 5) break;
    let sa = 0, sb = 0, sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < n; i++) { const x = a[i]!, y = b[i + lag]!; sa += x; sb += y; sab += x * y; saa += x * x; sbb += y * y; }
    const cov = sab - (sa * sb) / n, va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n;
    const r = va > 1e-12 && vb > 1e-12 ? cov / Math.sqrt(va * vb) : 0;
    if (r > best) { best = r; bestLag = lag; }
  }
  // level of the recording while the beeps were playing (envelope of the aligned part where the played envelope is high)
  let s = 0, c = 0; for (let i = 0; i < a.length && i + bestLag < b.length; i++) if (a[i]! > meanA) { s += b[i + bestLag]! ** 2; c++; }
  const pickedUpDb = toDb(Math.sqrt(s / Math.max(1, c)));
  return { correlation: Math.round(best * 1000) / 1000, lagMs: bestLag * 10, pickedUpDb, detected: best >= 0.55 && pickedUpDb > -55 };
}

// ---------------------------------------------------------------- suggestions
export interface DeviceSummary { inputs: { id: string; label: string }[]; outputs: { id: string; label: string }[]; selectedInputId?: string; selectedOutputId?: string }

export interface WizardInput {
  devices?: DeviceSummary;
  micError?: 'denied' | 'not-found' | 'in-use' | 'other' | null;
  levels?: MicLevels | null;
  echo?: EchoResult | null;
  settings: Pick<AudioSettings, 'echoCancellation' | 'autoGainControl' | 'noiseSuppression' | 'noiseSuppressionMode' | 'noiseStrength' | 'musicMode'>;
  connection?: Pick<ConnectionStats, 'rttMs' | 'packetLossPct' | 'transport'> & { jitterMs?: number | null } | null;
  /** RNNoise could not run / stalled during a call. */
  noiseFallback?: string | null;
}
export interface Suggestion {
  id: string; severity: 'info' | 'warn' | 'fail'; title: string; detail: string;
  /** Settings the "Fix it" button applies. */
  apply?: Partial<AudioSettings>;
}

const BLUETOOTH = /bluetooth|hands-?free|airpods|buds|headset.*(hfp|hsp)|wh-1000|bose|jabra.*(bt|link)/i;

/** Turns measurements into plain-language findings, worst first. Pure. */
export function suggestFixes(i: WizardInput): Suggestion[] {
  const out: Suggestion[] = [];
  const add = (s: Suggestion) => out.push(s);
  if (i.micError === 'denied') add({ id: 'perm', severity: 'fail', title: 'Microphone access is blocked', detail: 'Allow the microphone for this site from the lock icon in the address bar (and in your system privacy settings), then run the test again.' });
  else if (i.micError === 'not-found') add({ id: 'nomic', severity: 'fail', title: 'No microphone found', detail: 'Plug in or enable a microphone, or pick a different input device in Voice settings.' });
  else if (i.micError === 'in-use') add({ id: 'busy', severity: 'fail', title: 'The microphone is busy', detail: 'Another app is using it exclusively. Close other calls or recording apps and try again.' });
  else if (i.micError) add({ id: 'micerr', severity: 'fail', title: 'The microphone could not be opened', detail: 'Try another input device or reload the page.' });

  if (i.devices) {
    if (!i.devices.inputs.length && !i.micError) add({ id: 'noinput', severity: 'fail', title: 'No input devices are listed', detail: 'The browser does not see any microphone. Check the cable or the system sound settings.' });
    const sel = i.devices.inputs.find((d) => d.id === i.devices!.selectedInputId) ?? i.devices.inputs[0];
    if (sel && BLUETOOTH.test(sel.label)) add({ id: 'bt', severity: 'warn', title: 'Bluetooth microphone in use', detail: 'Bluetooth headsets drop to a low-quality call mode when the microphone is on, which sounds thin and choppy. For clearer audio use a wired or USB microphone and keep the headset only for listening.' });
    if (i.devices.outputs.length === 0) add({ id: 'noout', severity: 'info', title: 'Output device cannot be chosen', detail: 'This browser does not let Jorcord pick a speaker. Change the output in your system sound settings.' });
  }

  const L = i.levels;
  if (L) {
    if (L.speechDb < -70) add({ id: 'silent', severity: 'fail', title: 'The microphone is silent', detail: 'No sound was picked up. Check that it is not muted in your system, that the right input device is selected and that the headset switch is on.' });
    else {
      if (L.clippedPct > 0.5 || L.peakDb > -0.5) add({ id: 'clip', severity: 'warn', title: 'Your voice is too loud and distorting', detail: 'The signal hits the maximum. Lower the microphone volume in your system settings or move back from the microphone.', ...(i.settings.autoGainControl ? {} : { apply: { autoGainControl: true } }) });
      else if (L.speechDb < -38) add({ id: 'quiet', severity: 'warn', title: 'Your voice is very quiet', detail: 'Raise the microphone volume in your system settings or move closer. Turning on automatic gain control can also help.', ...(i.settings.autoGainControl ? {} : { apply: { autoGainControl: true } }) });
      if (L.noiseFloorDb > -45) add({ id: 'noisy', severity: 'warn', title: 'Lots of background noise', detail: 'The room is loud compared to your voice. Noise suppression helps; Strong also uses the browser filter.', ...(i.settings.noiseSuppression && i.settings.noiseStrength === 'strong' ? {} : { apply: { ...applyNoiseStrength('strong') } }) });
      else if (L.speechDb - L.noiseFloorDb < 18 && L.noiseFloorDb > -55) add({ id: 'snr', severity: 'info', title: 'Voice and background are close in level', detail: 'Speak closer to the microphone or turn on noise suppression.', ...(i.settings.noiseSuppression ? {} : { apply: { ...applyNoiseStrength('standard') } }) });
    }
  }

  const E = i.echo;
  if (E?.detected) {
    add({ id: 'echo', severity: 'warn', title: 'Your speakers are being picked up by the microphone', detail: `The test sound came back about ${E.lagMs} ms later. Use headphones, or lower the speaker volume. Keep echo cancellation on so others do not hear themselves.`, ...(i.settings.echoCancellation ? {} : { apply: { echoCancellation: true } }) });
  } else if (E && !i.settings.echoCancellation) {
    add({ id: 'aec-off', severity: 'info', title: 'Echo cancellation is off', detail: 'No echo was measured, but with speakers it is safer to keep echo cancellation on.', apply: { echoCancellation: true } });
  }

  if (i.noiseFallback) add({ id: 'rnnoise', severity: 'warn', title: 'Advanced noise suppression had to switch off', detail: 'It could not keep up on this device, so the browser filter is used instead. This avoids robotic or cut-out voice. You can try Light strength, or close heavy apps.', apply: { ...applyNoiseStrength('light'), noiseSuppressionMode: 'browser' } });
  if (i.settings.musicMode) add({ id: 'music', severity: 'info', title: 'Music mode is on', detail: 'Music mode turns off echo cancellation, gain control and noise suppression. Turn it off for normal talking.', apply: { musicMode: false } });

  const C = i.connection;
  if (C) {
    if ((C.packetLossPct ?? 0) >= 5) add({ id: 'loss', severity: 'warn', title: 'Packets are being lost', detail: `${C.packetLossPct}% of audio packets are lost, which makes voice choppy. Move closer to the Wi-Fi router or use a cable, and pause large downloads.` });
    if ((C.jitterMs ?? 0) >= 50) add({ id: 'jitter', severity: 'warn', title: 'Unsteady connection (high jitter)', detail: `Jitter is ${C.jitterMs} ms. Wi-Fi interference or a busy network cause this; a cable fixes most cases.` });
    if ((C.rttMs ?? 0) >= 300) add({ id: 'ping', severity: 'warn', title: 'High ping', detail: `Round trip is ${C.rttMs} ms, so conversation will feel delayed.` });
    if (C.transport === 'relay' || C.transport === 'tcp') add({ id: 'path', severity: 'info', title: C.transport === 'relay' ? 'Audio goes through a relay' : 'Audio uses TCP', detail: 'A firewall or VPN is stopping direct UDP, which adds delay. Turning off the VPN or allowing UDP usually helps.' });
  }

  if (!out.length) add({ id: 'ok', severity: 'info', title: 'No problems found', detail: 'Levels, echo and connection all look healthy. If others still report trouble, ask them to run the test too.' });
  const rank = { fail: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
