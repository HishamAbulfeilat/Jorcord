import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RegexError, RegexTimeout, MAX_INPUT, compileSafeRegex } from '../src/lib/saferegex';
import { Api, startServer, type TestEnv } from './helpers';

let env: TestEnv, api: Api;
beforeAll(async () => { env = await startServer(); api = new Api(env); });
afterAll(async () => { await env.close(); });

describe('AutoMod regex DoS limits', () => {
  it('caps program size, input length and enforces a time budget', () => {
    expect(() => compileSafeRegex('(?:a|b|c|d|e|f|g|h)'.repeat(30))).toThrow(RegexError); // >200 instructions
    expect(MAX_INPUT).toBeLessThanOrEqual(500);
    expect(compileSafeRegex('needle').test('x'.repeat(600) + 'needle')).toBe(false); // only the first 500 chars are scanned
    expect(compileSafeRegex('needle').test('x'.repeat(100) + 'needle')).toBe(true);
    expect(() => compileSafeRegex('a*b').test('a'.repeat(400), Date.now() - 1)).toThrow(RegexTimeout);
  });
  it('limits patterns per rule and regex rules per guild', async () => {
    const owner = await api.register('o');
    const guild = (await api.req('POST', '/guilds', owner.token, { name: 'Re', template: 'community' })).body;
    const rule = (b: object) => api.req('POST', `/guilds/${guild.id}/automod/rules`, owner.token, b);
    expect((await rule({ name: 'x', trigger: 'regex', regexPatterns: ['a', 'b', 'c', 'd'], action: 'block' })).status).toBe(400);
    for (let i = 0; i < 5; i++) expect((await rule({ name: 'r' + i, trigger: 'regex', regexPatterns: ['a', 'b', 'c'], action: 'block' })).status).toBe(201);
    const over = await rule({ name: 'r6', trigger: 'regex', regexPatterns: ['a'], action: 'block' });
    expect(over.status).toBe(400); expect(over.body.code).toBe('LIMIT_REACHED');
  });
});
