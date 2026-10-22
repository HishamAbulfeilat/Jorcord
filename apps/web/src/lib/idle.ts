/**
 * Automatic idle presence. After N minutes without input an `online` user becomes `idle`; the first input (or a wake from sleep) brings them back.
 * Only the automatic idle is ever undone: DND / invisible are never touched, and picking a status by hand cancels the automation until it is
 * next needed. On the desktop app the OS reports system-wide input (Windows / macOS); everywhere else we watch this window's own events.
 */
import type { Presence } from '@jorcord/shared';
import { onPowerEvent, systemIdleSeconds } from './native';
import { useData } from '@/stores/data';
import { useUI } from '@/stores/ui';
import { setMyPresence } from '@/components/layout/statusMenu';

export interface IdleDeps {
  /** Minutes of inactivity before idle; 0 disables. */ minutes: () => number;
  /** My current presence, or null before login. */ presence: () => Presence | null;
  setPresence: (p: Presence) => void;
  /** Seconds since last input system-wide, or null when only in-window activity is known. */ systemIdle: () => Promise<number | null>;
  now: () => number;
}

/** The state machine, separated from timers and DOM so it can be tested. `activity()` reports in-window input; `tick()` is the periodic check. */
export function createIdleController(d: IdleDeps) {
  let lastActivity = d.now();
  let auto = false; // true while the current `idle` was set by us
  const wake = () => { if (auto) { auto = false; if (d.presence() === 'idle') d.setPresence('online'); } };
  return {
    activity() { lastActivity = d.now(); wake(); },
    /** Machine woke from sleep: treat it as fresh input (the user is back) once presence has been restored. */
    resumed() { lastActivity = d.now(); wake(); },
    async tick() {
      const cur = d.presence(); const mins = d.minutes();
      if (!cur) return;
      if (auto && cur !== 'idle') auto = false; // the user picked something else by hand
      if (mins <= 0) { wake(); return; }
      let idleMs = d.now() - lastActivity;
      const sys = await d.systemIdle();
      if (sys !== null) { idleMs = sys * 1000; if (idleMs < 5000 && auto) { lastActivity = d.now(); wake(); return; } }
      if (idleMs >= mins * 60_000) { if (!auto && cur === 'online') { auto = true; d.setPresence('idle'); } }
      else wake();
    },
    isAuto: () => auto,
  };
}

/** Wire the controller to the DOM, the desktop power events and a 15 s timer. Returns the cleanup. */
export function startIdleDetection(): () => void {
  const c = createIdleController({
    minutes: () => useUI.getState().prefs.idleMinutes,
    presence: () => { const s = useData.getState(); return s.me ? (s.presences[s.me.id] ?? 'online') : null; },
    setPresence: (p) => setMyPresence(p),
    systemIdle: systemIdleSeconds,
    now: () => Date.now(),
  });
  const evs = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'focus'] as const;
  let last = 0;
  const onAct = () => { const t = Date.now(); if (t - last < 1000) return; last = t; c.activity(); }; // throttled: mousemove fires constantly
  evs.forEach((e) => window.addEventListener(e, onAct, { passive: true }));
  const offPower = onPowerEvent(() => c.resumed());
  const timer = setInterval(() => { void c.tick(); }, 15_000);
  return () => { evs.forEach((e) => window.removeEventListener(e, onAct)); offPower(); clearInterval(timer); };
}
