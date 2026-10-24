/**
 * Just-in-time permission flow. `ensurePermission(kind)` is called on the user action that needs the permission:
 * granted -> true at once; will-prompt -> explainer first, then the real prompt; blocked -> instructions + Retry.
 * The dialog itself is `PermissionHost` (mounted once in App).
 */
import { create } from 'zustand';
import { classifyMediaError, queryPermission, requestPermission, type MediaFailure, type PermKind, type PermState } from './permissions';

export interface PermPrompt { id: number; kind: PermKind; mode: 'explain' | 'blocked'; failure?: MediaFailure; busy?: boolean }
interface PermFlowState { current: PermPrompt | null; set(p: PermPrompt | null): void }
export const usePermFlow = create<PermFlowState>((set) => ({ current: null, set: (current) => set({ current }) }));

const EXPLAINED_KEY = 'jorcord.perm.explained.v1';
const explained = (): string[] => { try { return JSON.parse(localStorage.getItem(EXPLAINED_KEY) ?? '[]'); } catch { return []; } };
const markExplained = (k: PermKind) => { try { const l = new Set(explained()); l.add(k); localStorage.setItem(EXPLAINED_KEY, JSON.stringify([...l])); } catch { /* storage may be unavailable */ } };

let nextId = 1;
const waiters = new Map<number, (ok: boolean) => void>();

/** Called by the dialog when it is finished (true = the permission is usable now). */
export function settlePrompt(id: number, ok: boolean) {
  const cur = usePermFlow.getState().current;
  if (cur?.id === id) usePermFlow.getState().set(null);
  const w = waiters.get(id); if (w) { waiters.delete(id); w(ok); }
}

/** Run the real request for the open dialog; on failure it flips to the blocked view. Used by Continue and Retry. */
export async function continuePrompt(id: number): Promise<void> {
  const cur = usePermFlow.getState().current; if (!cur || cur.id !== id) return;
  usePermFlow.getState().set({ ...cur, busy: true });
  markExplained(cur.kind);
  const r = await requestPermission(cur.kind);
  if (usePermFlow.getState().current?.id !== id) return; // settled meanwhile (e.g. the live state turned granted)
  if (r.ok) { settlePrompt(id, true); return; }
  usePermFlow.getState().set({ id, kind: cur.kind, mode: 'blocked', failure: r.failure ?? 'other' });
}

function open(kind: PermKind, mode: PermPrompt['mode'], failure?: MediaFailure): Promise<boolean> {
  // a newer request replaces an older dialog; the older caller is told "no"
  const old = usePermFlow.getState().current; if (old) settlePrompt(old.id, false);
  const id = nextId++;
  return new Promise<boolean>((res) => { waiters.set(id, res); usePermFlow.getState().set({ id, kind, mode, failure }); });
}

/**
 * Resolve true when the caller may go ahead and use the device. Resolves false when the user declined or the permission is blocked
 * (the dialog has already explained what to do). An unknown state (Safari/Firefox cannot be queried) goes straight to the browser prompt;
 * wrap the real capture in try/catch and call `reportPermissionFailure` for what it throws.
 */
export async function ensurePermission(kind: PermKind): Promise<boolean> {
  const state: PermState = await queryPermission(kind);
  if (state === 'granted') return true;
  if (state === 'unsupported') return true; // nothing to ask; the caller's own capability check reports the real reason
  if (state === 'denied') return open(kind, 'blocked', 'denied');
  if (state === 'unknown') return kind === 'screen' && !explained().includes('screen') ? open(kind, 'explain') : true;
  if (kind === 'screen' && explained().includes('screen')) return true; // 'prompt' every time; explained once is enough
  return open(kind, 'explain');
}

/** Show the right message for a capture error thrown after the real getUserMedia / getDisplayMedia call. Resolves true if the user fixed it and wants to retry. */
export function reportPermissionFailure(kind: PermKind, err: unknown): Promise<boolean> {
  const failure = classifyMediaError(err);
  if (failure === 'cancelled' && kind === 'screen') return Promise.resolve(false); // the user closed the picker: not an error
  return open(kind, 'blocked', failure);
}

/** Same as reportPermissionFailure when you already have the failure kind (e.g. from a VoiceError code). */
export function reportFailure(kind: PermKind, failure: MediaFailure): Promise<boolean> { return open(kind, 'blocked', failure); }
