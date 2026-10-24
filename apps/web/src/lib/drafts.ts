/** Per-channel composer drafts, mirrored to localStorage so they survive a reload (cleared when the message is sent). */
const KEY = 'jorcord.drafts.v1';
const MAX_DRAFTS = 100;
type Store = { uid: string; items: Record<string, { t: string; at: number }> };

function read(): Store | null {
  try { const raw = localStorage.getItem(KEY); if (!raw) return null; const v = JSON.parse(raw); return v && typeof v === 'object' && typeof v.uid === 'string' && v.items && typeof v.items === 'object' ? (v as Store) : null; } catch { return null; }
}

/** The saved draft of a channel for this account ('' when none). A different account's drafts are never returned. */
export function loadDraft(uid: string | undefined, channelId: string): string {
  if (!uid) return '';
  const s = read(); const d = s && s.uid === uid ? s.items[channelId] : undefined;
  return d && typeof d.t === 'string' ? d.t : '';
}

/** Saves (or, for an empty text, removes) a channel draft. Never throws: storage can be unavailable or full. */
export function saveDraft(uid: string | undefined, channelId: string, text: string, now = Date.now()): void {
  if (!uid) return;
  try {
    let s = read(); if (!s || s.uid !== uid) s = { uid, items: {} };
    if (text.trim()) s.items[channelId] = { t: text, at: now }; else delete s.items[channelId];
    const keys = Object.keys(s.items);
    if (keys.length > MAX_DRAFTS) for (const k of keys.sort((a, b) => s!.items[a]!.at - s!.items[b]!.at).slice(0, keys.length - MAX_DRAFTS)) delete s.items[k];
    if (Object.keys(s.items).length) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY);
  } catch { /* storage blocked or full: drafts then live in memory only */ }
}

export const clearDrafts = () => { try { localStorage.removeItem(KEY); } catch { /* */ } };
