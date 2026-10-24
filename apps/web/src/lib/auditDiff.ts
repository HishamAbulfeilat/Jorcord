/** Human-readable lines for an audit entry's `diff` (docs/MODERATION.md): permission bitfields become added/removed names, role ids become role names. */
import { permNamesOf, permissionDelta, type AuditEntry } from '@jorcord/shared';

export interface DiffLine { field: string; before: string | null; after: string | null; added?: string[]; removed?: string[] }
const PERM_FIELDS = new Set(['permissions', 'allow', 'deny']);
const ROLE_LIST_FIELDS = new Set(['roles']);

const words = (k: string) => k.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').trim().toLowerCase().replace(/^./, (c) => c.toUpperCase());
const permLabel = (n: string) => n.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

function show(field: string, v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if ((field === 'color' || field === 'colorSecondary') && typeof v === 'number') return v ? `#${v.toString(16).padStart(6, '0')}` : 'none';
  if (typeof v === 'string') return v.length > 120 ? `${v.slice(0, 117)}...` : v;
  if (typeof v === 'number') return String(v);
  const j = JSON.stringify(v);
  return j.length > 160 ? `${j.slice(0, 157)}...` : j;
}

/** One line per changed field. `roleName` resolves ids in role lists; unknown ids show as they are. */
export function diffLines(e: Pick<AuditEntry, 'diff'>, roleName: (id: string) => string = (id) => id): DiffLine[] {
  const d = e.diff; if (!d) return [];
  const keys = [...new Set([...Object.keys(d.before ?? {}), ...Object.keys(d.after ?? {})])];
  return keys.map((k): DiffLine => {
    const b = d.before?.[k], a = d.after?.[k];
    if (PERM_FIELDS.has(k) && (typeof a === 'string' || typeof b === 'string' || a === null || b === null)) {
      const delta = permissionDelta(typeof b === 'string' ? b : '0', typeof a === 'string' ? a : '0');
      return { field: words(k), before: null, after: null, added: delta.added.map(permLabel), removed: delta.removed.map(permLabel) };
    }
    if (ROLE_LIST_FIELDS.has(k) && Array.isArray(a ?? b ?? [])) {
      const bs = new Set(((b as string[]) ?? [])), as = new Set(((a as string[]) ?? []));
      return { field: words(k), before: null, after: null, added: [...as].filter((x) => !bs.has(x)).map(roleName), removed: [...bs].filter((x) => !as.has(x)).map(roleName) };
    }
    return { field: words(k), before: show(k, b), after: show(k, a) };
  });
}

/** Permission names in a bitfield for display (used where a whole mask is shown, not a delta). */
export const permList = (bits: string): string[] => permNamesOf(bits).map(permLabel);
