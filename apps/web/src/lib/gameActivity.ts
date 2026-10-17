/**
 * Desktop game detection: poll the running-process list and mirror the first detected game as a
 * "Playing <game>" activity. No-op outside Tauri (plain web / PWA), where there is no process list.
 */
import type { Activity } from '@jorcord/shared';
import { api } from './api';
import { desktop, type DetectedGame, type GameExecutable } from './native';
import { useUI, type RegisteredGame } from '@/stores/ui';
import { useData } from '@/stores/data';

let current: DetectedGame | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/** The game currently reported as "Playing", or null. */
export const currentGame = (): DetectedGame | null => current;

/** Mirror the server's activity list into the local store so the change shows immediately. */
function applyMine(activities: Activity[]) {
  const id = useData.getState().me?.id;
  if (id) useData.setState((st) => ({ activities: { ...st.activities, [id]: activities } }));
}

/** One detection pass: set "Playing <game>" when a game starts, clear it when nothing is running. */
export async function pollGameActivity(userGames: RegisteredGame[] = [], enabled = true): Promise<void> {
  if (!desktop.available()) return;
  if (!enabled) { await resetGameActivity(); return; }
  let games: DetectedGame[];
  try { games = (await desktop.listRunningGames(userGames as GameExecutable[])).games; } catch { return; }
  const next = games[0] ?? null;
  if (next?.name === current?.name) return; // nothing changed since the last pass
  try {
    if (next) { const r = await api.users.setActivities([{ type: 'playing', name: next.name }]); current = next; applyMine(r.activities); }
    else if (current) { await api.users.clearActivities(); current = null; applyMine([]); }
  } catch { /* network hiccup: try again on the next pass */ }
}

/** Clear the activity we set (leaves a manually-set activity alone when we never reported a game). */
export async function resetGameActivity(): Promise<void> {
  if (!current) return;
  current = null;
  try { await api.users.clearActivities(); applyMine([]); } catch { /* */ }
}

/** Start polling for games every `intervalMs`. Reads the current preferences on each pass. Returns the cleanup. */
export function startGameDetection(intervalMs = 15_000): () => void {
  stopGameDetection();
  if (!desktop.available()) return stopGameDetection;
  const tick = () => { const p = useUI.getState().prefs; void pollGameActivity(p.registeredGames, p.gameActivity); };
  tick();
  timer = setInterval(tick, intervalMs);
  return stopGameDetection;
}

/** Stop polling. Does not clear the activity (the user's toggle or logout does that). */
export function stopGameDetection(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
