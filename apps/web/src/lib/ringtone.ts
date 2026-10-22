/** Incoming-call ring: a two-tone phrase repeated every 2 s until stopped. WebAudio only (no assets); a blocked AudioContext just stays silent. */
let ctx: AudioContext | null = null;

export function playRingPhrase(): void {
  try {
    ctx ??= new (window.AudioContext || (window as any).webkitAudioContext)();
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    const t0 = ctx.currentTime;
    // ring-ring: two bursts of a 440+480 Hz pair
    for (const at of [0, 0.45]) {
      for (const f of [440, 480]) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0 + at); g.gain.exponentialRampToValueAtTime(0.07, t0 + at + 0.03); g.gain.setValueAtTime(0.07, t0 + at + 0.32); g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.38);
        o.connect(g).connect(ctx.destination); o.start(t0 + at); o.stop(t0 + at + 0.4);
      }
    }
  } catch { /* autoplay blocked */ }
}

export interface RingLoop { stop(): void }
/** Starts the loop immediately. Injectable for tests. */
export function startRingLoop(play: () => void = playRingPhrase, intervalMs = 2000, timers: Pick<typeof globalThis, 'setInterval' | 'clearInterval'> = globalThis): RingLoop {
  play();
  const id = timers.setInterval(play, intervalMs);
  let stopped = false;
  return { stop() { if (stopped) return; stopped = true; timers.clearInterval(id); } };
}
