/** Linked-role presentation and editor helpers (pure, unit tested). The server validates everything again. */
import { LINKED_ROLE_LIMITS, type LinkedCriterion, type LinkedCriterionProgress, type LinkedOp, type RoleMetadataApp } from '@jorcord/shared';

export const CRITERION_TYPES: { id: LinkedCriterion['type']; label: string }[] = [
  { id: 'account_age_days', label: 'Account is at least N days old' }, { id: 'join_age_days', label: 'Member of this server for N days' },
  { id: 'message_count', label: 'Has sent N messages here' }, { id: 'connection', label: 'Has a verified connection' }, { id: 'app_metadata', label: 'App-provided value' },
];
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const OPS: Record<LinkedOp, string> = { '>=': 'at least', '<=': 'at most', '=': 'equal to', '!=': 'not equal to' };

/** One line for a criterion ("Account is at least 30 days old"). `apps` resolves app and field names. */
export function describeCriterion(c: LinkedCriterion, apps: RoleMetadataApp[] = []): string {
  switch (c.type) {
    case 'account_age_days': return c.value === 0 ? 'Any account' : `Account is at least ${plural(c.value, 'day', 'days')} old`;
    case 'join_age_days': return c.value === 0 ? 'Any member' : `Member of this server for ${plural(c.value, 'day', 'days')}`;
    case 'message_count': return `Has sent at least ${plural(c.value, 'message', 'messages')} here`;
    case 'connection': return c.provider ? `Has a verified ${c.provider} connection` : 'Has a verified connection';
    case 'app_metadata': {
      const app = apps.find((a) => a.appId === c.appId), f = app?.fields.find((x) => x.key === c.key);
      const what = `${app?.name ?? 'App'}: ${f?.name ?? c.key}`;
      return typeof c.value === 'boolean' ? `${what} is ${c.op === '!=' ? (c.value ? 'not yes' : 'not no') : c.value ? 'yes' : 'no'}` : `${what} is ${OPS[c.op]} ${c.value}`;
    }
  }
}
/** "12 / 30 days" style progress for the caller; null when nothing useful can be said. */
export function progressText(c: LinkedCriterion, p: LinkedCriterionProgress): string | null {
  if (p.current === null) return p.met ? null : 'No value reported yet';
  if (c.type === 'connection') return p.met ? 'Verified' : 'Not verified yet';
  if (c.type === 'app_metadata') return typeof p.current === 'boolean' ? (p.current ? 'Yes' : 'No') : `Currently ${p.current}`;
  const unit = c.type === 'message_count' ? 'messages' : 'days';
  return `${p.current} / ${c.value} ${unit}`;
}

export interface CriterionDraft { type: LinkedCriterion['type']; value: string; provider: string; appId: string; key: string; op: LinkedOp }
export const blankDraft = (type: LinkedCriterion['type'] = 'message_count'): CriterionDraft => ({ type, value: type === 'message_count' ? '10' : '30', provider: '', appId: '', key: '', op: '>=' });
const intIn = (s: string, lo: number, hi: number) => { const n = Number(s); return /^-?\d+$/.test(s.trim()) && n >= lo && n <= hi ? n : null; };

/** Draft -> criterion, or a message saying what is wrong. App values are checked against the field type. */
export function draftToCriterion(d: CriterionDraft, apps: RoleMetadataApp[] = []): { criterion: LinkedCriterion } | { error: string } {
  switch (d.type) {
    case 'account_age_days': case 'join_age_days': { const n = intIn(d.value, 0, LINKED_ROLE_LIMITS.maxDays); return n === null ? { error: `Days must be between 0 and ${LINKED_ROLE_LIMITS.maxDays}` } : { criterion: { type: d.type, value: n } }; }
    case 'message_count': { const n = intIn(d.value, 1, LINKED_ROLE_LIMITS.maxCount); return n === null ? { error: 'Messages must be between 1 and 1,000,000' } : { criterion: { type: 'message_count', value: n } }; }
    case 'connection': return { criterion: d.provider ? { type: 'connection', provider: d.provider } : { type: 'connection' } };
    case 'app_metadata': {
      const f = apps.find((a) => a.appId === d.appId)?.fields.find((x) => x.key === d.key); if (!f) return { error: 'Pick an app and a field' };
      if (f.type === 'boolean') return { criterion: { type: 'app_metadata', appId: d.appId, key: d.key, op: d.op === '!=' ? '!=' : '=', value: d.value !== 'false' } };
      const n = intIn(d.value, -LINKED_ROLE_LIMITS.metadataMax, LINKED_ROLE_LIMITS.metadataMax); return n === null ? { error: 'Enter a whole number' } : { criterion: { type: 'app_metadata', appId: d.appId, key: d.key, op: d.op, value: n } };
    }
  }
}
export function draftsToCriteria(ds: CriterionDraft[], apps: RoleMetadataApp[] = []): { criteria: LinkedCriterion[] } | { error: string } {
  if (!ds.length) return { error: 'Add at least one criterion' };
  const out: LinkedCriterion[] = [];
  for (const d of ds) { const r = draftToCriterion(d, apps); if ('error' in r) return r; out.push(r.criterion); }
  return { criteria: out };
}
