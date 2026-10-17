import { describe, expect, it } from 'vitest';
import { AuditActionType } from '@jorcord/shared';
import { AUDIT_FILTER_GROUPS, actionLabel, entryDetail, entryType, humanize } from './audit';

describe('audit log presentation', () => {
  const all = AUDIT_FILTER_GROUPS.flatMap((g) => g.items);
  it('every filter carries the numeric actionType the server accepts', () => { for (const a of all) expect(a.type).toBe(AuditActionType[a.value as keyof typeof AuditActionType]); expect(new Set(all.map((a) => a.type)).size).toBe(all.length); });
  it('offers every action added in the platform pass', () => {
    for (const a of ['BOT_ADD', 'MESSAGE_DELETE', 'MESSAGE_PIN', 'MESSAGE_UNPIN', 'MEMBER_UPDATE', 'STICKER_UPDATE', 'STAGE_INSTANCE_CREATE', 'STAGE_INSTANCE_UPDATE', 'STAGE_INSTANCE_DELETE', 'GUILD_SCHEDULED_EVENT_CREATE', 'GUILD_SCHEDULED_EVENT_UPDATE', 'GUILD_SCHEDULED_EVENT_DELETE', 'THREAD_DELETE', 'APPLICATION_COMMAND_PERMISSION_UPDATE', 'POLL_END', 'FORUM_TAG_UPDATE']) expect(all.some((x) => x.value === a), a).toBe(true);
  });
  it('labels read as sentences, unknown actions are humanized', () => { expect(actionLabel('BOT_ADD')).toBe('added a bot'); expect(actionLabel('POLL_END')).toBe('ended a poll'); expect(actionLabel('SOMETHING_NEW')).toBe('something new'); expect(humanize('ROLE_CREATE')).toBe('Role create'); });
  it('prefers the numeric type of the entry, else derives it from the string action', () => { expect(entryType({ action: 'BOT_ADD', actionType: 99 })).toBe(99); expect(entryType({ action: 'BOT_ADD' })).toBe(AuditActionType.BOT_ADD); expect(entryType({ action: 'NOPE' })).toBeUndefined(); });
  it('details come from change fields', () => { expect(entryDetail({ changes: { name: 'general', topic: 'hi' } })).toBe('name: general • topic: hi'); expect(entryDetail({ changes: null })).toBeNull(); expect(entryDetail({ changes: { x: 1 } })).toBeNull(); });
});
