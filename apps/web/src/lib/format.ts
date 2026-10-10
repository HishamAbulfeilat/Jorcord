import { snowflakeTime } from '@jorcord/shared';
import type { Channel, Member, User } from '@jorcord/shared';
import { getLocaleTag } from '@/i18n';
import { apiBase, publicOrigin, serverPath } from './server';

export const fileUrl = (p: string | null | undefined): string | null => {
  if (!p) return null;
  if (/^(https?:|data:|blob:)/.test(p)) return p;
  if (p.startsWith('/')) return serverPath(p);
  return `${apiBase()}/files/${p}`;
};
const PALETTE = ['#5865f2', '#3ba55d', '#faa61a', '#ed4245', '#eb459e', '#9b59b6', '#1abc9c', '#e67e22'];
export const idColor = (id: string) => { let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0; return PALETTE[h % PALETTE.length]; };
export const displayName = (u: Pick<User, 'username' | 'displayName'>, m?: Pick<Member, 'nick'> | null) => m?.nick || u.displayName || u.username;
export const initials = (s: string) => s.split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase();

export const msgTime = (id: string, iso?: string) => (iso ? new Date(iso).getTime() : snowflakeTime(id));
export const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString(getLocaleTag(), { hour: 'numeric', minute: '2-digit' });
export function fmtStamp(ms: number) {
  const d = new Date(ms), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const y = new Date(now.getTime() - 86400000);
  if (sameDay) return `Today at ${fmtTime(ms)}`;
  if (d.toDateString() === y.toDateString()) return `Yesterday at ${fmtTime(ms)}`;
  return `${d.toLocaleDateString()} ${fmtTime(ms)}`;
}
export const fmtDateDivider = (ms: number) => new Date(ms).toLocaleDateString(getLocaleTag(), { year: 'numeric', month: 'long', day: 'numeric' });
export const fmtFull = (ms: number) => new Date(ms).toLocaleString(getLocaleTag(), { dateStyle: 'full', timeStyle: 'short' });
export const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();
export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB']; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}
export const compare = (a: string, b: string) => { const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; };
export const compareId = (a: string | null | undefined, b: string | null | undefined) => (!a ? (!b ? 0 : -1) : !b ? 1 : compare(a, b));

export const isTextual = (c: Pick<Channel, 'type'>) => ['text', 'announcement', 'thread', 'dm', 'group_dm', 'voice', 'stage'].includes(c.type);
export const dmName = (c: Channel, meId?: string) => c.name || (c.recipients ?? []).filter((r) => r.id !== meId).map((r) => r.displayName || r.username).join(', ') || 'Unknown';
export const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(' ');
export const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));
export const copyText = async (t: string) => { try { await navigator.clipboard.writeText(t); return true; } catch { return false; } };
export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) { let t: ReturnType<typeof setTimeout>; return (...a: A) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
export const isImage = (ct: string) => ct.startsWith('image/');
export const isVideo = (ct: string) => ct.startsWith('video/');
export const isAudio = (ct: string) => ct.startsWith('audio/');
export const inviteUrl = (code: string) => `${publicOrigin()}/invite/${code}`;
