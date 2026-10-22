import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AuditActionType } from '@jorcord/shared';

/**
 * Walks every AuditActionType and asserts that server code can emit it, i.e. its name appears as a string literal in apps/server/src
 * (an `audit(...)` call naming it as a string literal on the same line). Actions that exist in the taxonomy but are
 * intentionally not written yet must be listed in RESERVED with the reason; the test also fails when a reserved action gains an emitter,
 * so the list cannot go stale.
 */
const RESERVED: Record<string, string> = {
  MEMBER_MOVE: 'voice moves are logged as VOICE_MOVE',
  MEMBER_DISCONNECT: 'voice disconnects are logged as VOICE_DISCONNECT',
  INTEGRATION_UPDATE: 'bot permission changes are logged as ROLE_UPDATE',
  INTEGRATION_CREATE: 'bot installs are logged as BOT_ADD; no other integration kind creates rows yet',
  INTEGRATION_DELETE: 'bot removals are logged as BOT_REMOVE; no other integration kind exists yet',
  APPLICATION_UPDATE: 'applications belong to a user, not a guild, so there is no guild audit log to write to',
  APPLICATION_TOKEN_RESET: 'applications belong to a user, not a guild, so there is no guild audit log to write to',
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sourceFiles(p) : /\.ts$/.test(f) ? [p] : [];
  });
}
const SRC = join(__dirname, '..', 'src');
const files = sourceFiles(SRC).map((p) => ({ p, text: readFileSync(p, 'utf8') }));
/** A line that calls an audit helper (audit(...), auditX(...), logAudit(...)) and names the action as a string literal. */
const emitted = (name: string) => {
  const lit = new RegExp(`['"\`]${name}['"\`]`);
  const call = new RegExp(`\\baudit\\w*\\([^\\n]*?['"\`]${name}['"\`]`);
  return files.some((f) => f.text.split('\n').some((line) => !/^\s*(\/\/|\*)/.test(line) && call.test(line) && lit.test(line)));
};

describe('audit log taxonomy', () => {
  const names = Object.keys(AuditActionType);

  it('has unique numeric values', () => {
    const values = Object.values(AuditActionType);
    expect(new Set(values).size).toBe(values.length);
  });

  it('every action has an emitter in apps/server/src or is listed as reserved', () => {
    const missing = names.filter((n) => !RESERVED[n] && !emitted(n));
    expect(missing, `AuditActionType entries without an emitter (emit them or add to RESERVED): ${missing.join(', ')}`).toEqual([]);
  });

  it('reserved actions exist in the taxonomy and have no emitter yet', () => {
    for (const [name, why] of Object.entries(RESERVED)) {
      expect(names, `${name} is reserved but not in AuditActionType`).toContain(name);
      expect(why.length).toBeGreaterThan(5);
      expect(emitted(name), `${name} now has an emitter: remove it from RESERVED`).toBe(false);
    }
  });
});
