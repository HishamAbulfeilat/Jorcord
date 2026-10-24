import { diffFields, type AuditDiff } from '@jorcord/shared';

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const pick = (row: Record<string, unknown> | null | undefined, cols: readonly string[]) => {
  const out: Record<string, unknown> = {};
  if (row) for (const c of cols) if (c in row) out[camel(c)] = row[c] instanceof Date ? (row[c] as Date).toISOString() : row[c];
  return out;
};

/** Audit diff of two database rows over the given snake_case columns (keys come out camelCase). `before` null = a creation, `after` null = a deletion. */
export function rowDiff(before: Record<string, unknown> | null | undefined, after: Record<string, unknown> | null | undefined, cols: readonly string[]): AuditDiff | null {
  const b = pick(before, cols), a = pick(after, cols);
  const out = diffFields(b, a);
  if (!out) return null;
  // a deletion keeps every old value (including nulls) so the entry still shows what the thing looked like
  if (!after) out.before = b;
  return out;
}

export const ROLE_COLS = ['name', 'color', 'color_secondary', 'hoist', 'permissions', 'mentionable', 'icon', 'position'] as const;
export const CHANNEL_COLS = ['name', 'topic', 'nsfw', 'slowmode', 'bitrate', 'user_limit', 'parent_id', 'position', 'archived', 'locked', 'require_tag', 'default_sort_order', 'default_forum_layout', 'default_reaction_emoji', 'default_thread_slowmode', 'default_auto_archive', 'auto_archive_minutes', 'available_tags', 'applied_tags', 'is_clips_channel'] as const;
export const GUILD_COLS = ['name', 'icon', 'banner', 'description', 'system_channel_id', 'rules_channel_id', 'vanity_url', 'tag', 'tag_badge', 'features'] as const;
export const SAFETY_COLS = ['verification_level', 'explicit_filter', 'default_notifications', 'raid_protection', 'link_allow', 'link_deny', 'impersonation_guard', 'safety_alerts_channel_id', 'safety_alerts', 'invites_paused_until', 'member_dms_restricted_at'] as const;
