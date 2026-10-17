# Discord desktop client: reverse-engineering findings and Jorcord feature plan

Source: static analysis with REA of the locally installed Discord stable build **1.0.9261** (Electron 42.7.1).
Targets: `resources/app.asar` (bootstrap/updater), `modules/discord_desktop_core-1/core.asar` (shell + `DiscordNative` preload),
and the JS wrappers + manifests of the 17 native modules in `modules/`. Native `.node`/`.dll` binaries were inventoried
but **not decompiled** (no Ghidra/IDA/Hopper configured), so native behaviour below is inferred from their JS wrappers.

## 0. What the install does and does not contain

- **Observed:** the installed app is a *shell*. `core.asar` loads the chat UI from a remote `WEBAPP_ENDPOINT`
  (`will-navigate` is locked to that origin). Guilds, channels, messages, roles, Nitro UI, settings screens, etc. are
  **not in the install** and cannot be recovered from it.
- **Consequence:** this document covers the *desktop/native* feature layer. The chat feature set stays as already planned in
  `PLAN.md` and `PARITY.md` (public Discord behaviour, Spacebar/Stoat references).
- Evidence is local only; nothing was executed or captured at runtime. Items marked *inferred* come from module names/JS
  wrappers, not from native code.

## 1. Architecture findings

| Layer | Observed | Jorcord mapping |
|---|---|---|
| `app.asar` bootstrap | Splash window (`splash/index.html`, quotes JSON, `splashScreenPreload.js`), updater with backoff (`DESKTOP_TTI_UPDATE_BACKOFF_*`, `ALLOW_OPTIONAL_UPDATES`, `SKIP_HOST_UPDATE`, `SKIP_MODULE_UPDATE`, `USE_PINNED_UPDATE_MANIFEST`), module bootstrap (`ALWAYS_BOOTSTRAP_MODULES`), build override status/clear IPC, Sentry | Tauri updater already present; add splash + update-state UI |
| `core.asar` main | Frameless window, min 320x180, bg `#2f3136`, window bounds/maximized/minimized persisted, minimize-to-tray, start-minimized, open-on-startup, single instance + `second-instance` argv handling, `setWindowOpenHandler` routes external links to a safe opener, `will-navigate` origin lock | Mostly present (window-state, single-instance, tray, autostart). Add: min size, origin lock, safe external opener, start-minimized, minimize-to-tray toggle |
| Preload bridge | `window.DiscordNative` with: `app, process, os, settings, nativeModules, clipboard, ipc, gpuSettings, window, spellCheck, crashReporter, desktopCapture, fileManager, processUtils, powerSaveBlocker, accessibility, features, userDataCache, safeStorage, http, isRenderer` | Define `window.JorcordNative` with the same grouping, backed by Tauri commands, with a no-op web fallback |
| Native modules (17) | See section 3 | Phase-mapped below |
| IPC | 73 operations in core (72 use computed channel names, so channel names are only partly literal) | Typed Tauri commands, one per capability |

## 2. `DiscordNative` surface (observed IPC names, grouped)

- **App:** badge count / dock badge+bounce, relaunch, get path, build number, release channel, arch, module versions, host version,
  preferred system languages, system UI direction, open-on-start get/set, default double-click action, analytics push,
  paint/bundle metrics, frame-evictor pause/unpause, quit-and-install, check-for-updates.
- **Window/tray:** minimize-to-tray, start-minimized, system tray icon/strings/states/application list, Thumbar buttons
  (Windows taskbar), mouse coordinates, display count, background colour update, navigation-history clear.
- **Notifications:** show/close/clear/remove, authorization status, settings, module status, response callback.
- **Clipboard:** copy/cut/paste (incl. image formats).
- **Files:** open/save dialogs, show item in folder, asset-cache path, module data/log paths, create-directory.
- **Power:** system idle time, lock/unlock/suspend/resume events, block/unblock display sleep (used during calls/streams).
- **Capture:** `desktopCapturer.getSources`, clips (load clips dir, load/move/delete clip, montage render recipe, clip-decider debug).
- **Security/storage:** `safeStorage` encrypt/decrypt/available (OS keychain), settings get/set (sync + async), user-data cache get/save/delete.
- **Search:** index/delete/clear domains and items (local search index in main process).
- **Spellcheck:** languages, locale, learned words, dictionaries, replace misspelling.
- **System:** GPU settings (hw-accel toggle, chromium switches), process utils (CPU, system info/metrics, flush cookies/DNS/storage,
  crash info), crash reporter, NTP clock sync, accessibility enabled, external URL open with confirmation request, intents activity (macOS).
- **Native modules manager:** install, get paths, finish bootstrap, installed event.

## 3. Native module inventory (observed names; behaviour *inferred*)

| Module | What it appears to do | Jorcord plan |
|---|---|---|
| `discord_voice` | Voice/video engine: connections, transports, MLS/E2EE (`getMLSKeyPackage`), encryption modes, spatial audio, PTT, local mute/pan/volume, speaking callbacks, desktop-source capture + soundshare, Go Live devices, replay/clip recording, stats, video sinks, VAAPI, selfie segmentation (`.tflite`), GPU encoder helper, audio effects helper | LiveKit in the webview (phase 3). Skip custom engine. Optional later: native capture helper |
| `discord_krisp` | AI noise suppression models (NC lite/med/pro, VAD) | Use RNNoise/WASM or LiveKit's noise filter. Do not ship Krisp models |
| `discord_media` | Build/arch/GPU stats, memory + system analytics blobs | Basic diagnostics panel only |
| `discord_overlay2` / `discord_desktop_overlay` / `discord_hook` | In-game overlay (host window, input lock, click zones, IME, perf info, injected `DiscordHook*.dll`) | **Out of scope**: DLL injection into games. Possible light alternative: always-on-top mini voice window |
| `discord_game_utils`, `discord_utils` | Game/candidate-game detection, global input capture (PTT / keybinds), GPU driver versions, logs | Rich presence via local RPC; global shortcuts via Tauri global-shortcut plugin |
| `discord_rpc` | Local RPC server: named pipe `discord-ipc-*` and a localhost WebSocket | Implement `jorcord-ipc` pipe + WS for bots/rich presence SDK (phase 5) |
| `discord_notifications` | Native notification layer (Windows) | Tauri notification plugin (present) |
| `discord_cloudsync` | Settings/state sync client (has `getAPIEndpoint`, `getLastState`) | Server-side user settings sync endpoint |
| `discord_dispatch` | Game install/dispatch (legacy store) | Skip |
| `discord_erlpack`, `discord_zstd` | Gateway ETF encoding and zstd compression | Optional gateway optimisation: msgpack + zstd-stream |
| `discord_spellcheck` | Spellcheck bridge | Webview spellcheck + learned words store |
| `discord_modules`, `discord_aegis` | Module manager, integrity/anti-tamper (`discord_aegis_*.dll`) | Skip |

## 4. Gap analysis vs Jorcord desktop (`apps/desktop`)

Present: tray, autostart, deep links, single instance, updater, window-state, notifications, opener, process.

Missing, in priority order:

**P1: expected in any desktop chat app**
1. `JorcordNative` bridge package (`packages/native`) + web fallbacks so `apps/web` can feature-detect.
2. Minimize-to-tray and start-minimized settings, close-to-tray behaviour, window min size.
3. Unread/mention badge (taskbar overlay on Windows, dock badge on macOS) and tray state icons (normal/unread/mention/muted-in-call).
4. Safe external-link opener with confirmation for untrusted domains; navigation origin lock.
5. Secure token storage via OS keychain (equivalent of `safeStorage`).
6. Clipboard image paste, open/save dialogs, show-in-folder for downloads.
7. Idle detection (auto-idle presence) and lock/suspend/resume events (presence + reconnect).
8. Block display sleep during calls/streams.
9. Splash window + update progress + optional vs required update handling with backoff.

**P2: voice and capture (with phase 3)**
10. Push-to-talk global shortcut and configurable keybinds (global-shortcut plugin; Wayland caveat).
11. Screen/window source picker for screen share; system-audio capture where supported.
12. Noise suppression toggle and device selection; "speaking while muted" hint.
13. Clips: rolling replay buffer to disk with trim/move/delete (stretch).

**P3: polish and ecosystem**
14. Local RPC pipe/WebSocket (rich presence for third-party apps and bots).
15. Local message search index in the desktop process (offline search), domain add/delete/clear API.
16. Spellcheck languages + learned words; accessibility flag; system language and text-direction detection.
17. GPU settings (hardware acceleration toggle) and diagnostics page (system info, logs path, crash reports).
18. Thumbar buttons (mute/deafen from the taskbar thumbnail) and tray quick actions.
19. Settings sync between devices (server endpoint).
20. In-game overlay: **not planned**.

## 5. Suggested delivery order

1. `packages/native` types + `JorcordNative` shim and Tauri commands for items 2-6 (one small PR).
2. Items 7-9, then add a Settings > Windows/Desktop page for tray/startup/hardware-acceleration toggles.
3. Items 10-12 alongside LiveKit voice.
4. Items 14-18 after phase 5.

## 6. Limits and ground rules

- No Discord code, assets, sounds, fonts, models (Krisp) or DLLs are copied. This file records capabilities only; implementations must be written fresh.
- Not covered: the chat UI itself (remote), server/gateway protocol, and anything inside native binaries, which need a Ghidra/IDA/Hopper setup to decompile.
- The install has no `.proto`/gateway code; the gateway opcode model in `PLAN.md` still comes from public documentation and Spacebar.
- Unknowns: exact IPC payload shapes (channel names are computed at runtime), native module internals, and whether newer builds change any of the above.
