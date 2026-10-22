// Bundled locally by Vite (emitted as a hashed asset on our own origin: no CDN, covered by script-src 'self').
import workletUrl from '@timephy/rnnoise-wasm/NoiseSuppressorWorklet?worker&url';
import { configureNoise } from '@jorcord/voice';

configureNoise({ workletUrl });
