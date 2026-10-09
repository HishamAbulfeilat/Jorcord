/** Tiny WebAudio blips so we ship no sound assets. */
let ctx: AudioContext | null = null;
export function playSound(kind: 'message' | 'mention' | 'join' | 'leave') {
  try {
    ctx ??= new (window.AudioContext || (window as any).webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    const f = { message: [660, 880], mention: [880, 1175], join: [523, 784], leave: [784, 523] }[kind];
    o.type = 'sine'; o.frequency.setValueAtTime(f[0], ctx.currentTime); o.frequency.setValueAtTime(f[1], ctx.currentTime + 0.08);
    g.gain.setValueAtTime(0.0001, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
    o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.25);
  } catch { /* autoplay blocked */ }
}
