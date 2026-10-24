# Voice and screen-share quality controls

All of this is free: no tiers, up to 4K60 / `source` limited only by `LIMITS.stream`.

## Screen share (`packages/voice/src/screenQuality.ts`, `adaptation.ts`)

* **Clarity vs smoothness** (`screenDegradation`: auto / clarity / smoothness) maps to LiveKit `degradationPreference` `maintain-resolution` / `maintain-framerate`. Auto picks clarity for text/detail and smoothness for motion. Text content at clarity is capped at 30 fps for sharper frames per bit. Changing it while live applies to the running sender.
* **Quality lock** (`screenLock {preset, fps?, bitrateKbps?}`): resolution (720p30 ... 4K60, source), fps (15/24/30/60) and bitrate (auto, 2.5, 6, 12, 25, max Mbps) are used as chosen (clamped to platform limits and device caps). A locked share is never stepped down by the governor.
* **Simulcast**: lower layers (360p/720p/1080p below the top) are always published, so viewers on slow links receive a lower layer (adaptiveStream + dynacast) instead of the sharer degrading.
* **Less jumpy adaptation**: `BitrateGovernor` sits on libwebrtc's estimator: steps down after 2 consecutive bad samples, up only after 8 healthy samples with 30% headroom and a minimum dwell, and every flap (down soon after up) doubles the wait before the next up (capped 60 s).

## Connection indicator and stats

`gradeConnection()` turns ping, loss and jitter into 0-4 bars with reasons. The connection popover shows quality, ping, jitter, loss and media path; "Open diagnostics" shows RTT, jitter, loss, audio/video codec, bitrate in/out and ICE path (UDP / TCP / TURN relay) with local/remote candidates.

## Noise suppression (`noiseTuning.ts`, `noise.ts`)

* Strength: Off / Light (60% wet) / Standard (88% wet + gentle gate) / Strong (100% wet + firmer gate + browser filter). A wet/dry slider overrides the mix; changing it retunes the live processor with no re-capture.
* Anti-robotic design: the dry signal is delayed by one RNNoise frame so wet and dry align; the gate uses lookahead (12-15 ms), hold (220-280 ms), slow release and a non-zero floor, and a watchdog opens it if timer updates stall.
* If the worklet outputs silence under active input (stall >800 ms or 4 dropouts in 5 s), or reports a processor error, the mic drops to the browser's built-in suppression and the UI says why.
* Echo cancellation and auto gain are independent toggles. Settings > Voice has a **Listen to yourself** A/B (original vs processed).

## "Audio problem? Run diagnostics"

Wizard in Voice settings: mic level (noise floor/speech/clipping), loopback echo test (a beep pattern through the speakers is recorded with echo cancellation off and envelope-correlated), record-and-play-back, device list, connection numbers, then `suggestFixes()` with one-click fixes. Audio never leaves the device. Pure logic and tests: `packages/voice/test/audioWizard.test.ts`.
