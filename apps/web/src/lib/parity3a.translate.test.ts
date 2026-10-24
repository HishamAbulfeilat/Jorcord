import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageFlags, Perm } from '@jorcord/shared';
import type { Message } from '@jorcord/shared';

vi.mock('@/lib/api', () => ({ api: { messages: { translateConfig: vi.fn(), translate: vi.fn(), setFlags: vi.fn() } } }));
import { api } from '@/lib/api';
import { _resetTranslateSupport, translateMessage, translateSupport, translateSupportCached, targetLanguage } from './translate';
import { embedsToggle } from './menus';

const m = api.messages as unknown as Record<string, ReturnType<typeof vi.fn>>;
beforeEach(() => { _resetTranslateSupport(); vi.clearAllMocks(); });
afterEach(() => { delete (globalThis as any).Translator; delete (globalThis as any).LanguageDetector; });

describe('message translation fallback chain', () => {
  it('is "none" (menu item disabled) when there is no browser API and no TRANSLATE_URL', async () => {
    expect(translateSupportCached()).toBeNull();
    m.translateConfig.mockResolvedValue({ available: false });
    expect(await translateSupport()).toBe('none'); expect(translateSupportCached()).toBe('none');
    await expect(translateMessage('c', 'm', 'hola', 'en')).rejects.toThrow(/not available/);
    expect(m.translate).not.toHaveBeenCalled();
  });
  it('falls back to the server endpoint when it is configured', async () => {
    m.translateConfig.mockResolvedValue({ available: true });
    m.translate.mockResolvedValue({ text: 'hello', detectedLanguage: 'es', to: 'en', messageId: 'm', cached: false });
    expect(await translateMessage('c', 'm', 'hola', 'en')).toEqual({ text: 'hello', via: 'server', detected: 'es' });
    expect(m.translate).toHaveBeenCalledWith('c', 'm', 'en');
  });
  it('prefers the on-device Translator API and never calls the server', async () => {
    (globalThis as any).LanguageDetector = { create: async () => ({ detect: async () => [{ detectedLanguage: 'es', confidence: 0.9 }] }) };
    const create = vi.fn(async (o: any) => ({ translate: async (t: string) => `[${o.sourceLanguage}>${o.targetLanguage}] ${t}` }));
    (globalThis as any).Translator = { create };
    expect(await translateSupport()).toBe('browser');
    expect(await translateMessage('c', 'm', 'hola', 'en-GB')).toEqual({ text: '[es>en] hola', via: 'browser', detected: 'es' });
    expect(m.translate).not.toHaveBeenCalled(); expect(m.translateConfig).not.toHaveBeenCalled();
  });
  it('uses the server when the browser cannot do the language pair', async () => {
    (globalThis as any).Translator = { create: async () => { throw new Error('unsupported pair'); } };
    m.translateConfig.mockResolvedValue({ available: true });
    m.translate.mockResolvedValue({ text: 'x', detectedLanguage: null, to: 'en', messageId: 'm', cached: true });
    expect((await translateMessage('c', 'm', 'hola', 'en')).via).toBe('server');
  });
  it('target language falls back to the browser language', () => { expect(targetLanguage('de')).toBe('de'); expect(targetLanguage(undefined)).toBeTruthy(); });
});

describe('Remove / Restore embeds menu item', () => {
  const msg = (o: Partial<Message> = {}) => ({ id: '9', channelId: 'c', type: 'default', content: 'look https://example.com', author: { id: 'me' }, embeds: [], flags: 0, ...o }) as unknown as Message;
  it('is offered to the author when there is a link, and to MANAGE_MESSAGES on others', () => {
    expect(embedsToggle(msg(), 'me', 0n)?.label).toBe('Remove Embeds');
    expect(embedsToggle(msg(), 'other', 0n)).toBeNull();
    expect(embedsToggle(msg(), 'other', Perm.MANAGE_MESSAGES)?.label).toBe('Remove Embeds');
    expect(embedsToggle(msg({ content: 'no links here' }), 'me', 0n)).toBeNull();
    expect(embedsToggle(msg({ flags: MessageFlags.SUPPRESS_EMBEDS }), 'me', 0n)?.label).toBe('Restore Embeds');
    expect(embedsToggle(msg({ type: 'join' as never }), 'me', 0n)).toBeNull();
  });
  it('PATCHes flags: SUPPRESS_EMBEDS to remove, 0 to restore', () => {
    m.setFlags.mockResolvedValue(msg());
    embedsToggle(msg(), 'me', 0n)!.onClick?.(); expect(m.setFlags).toHaveBeenLastCalledWith('c', '9', MessageFlags.SUPPRESS_EMBEDS);
    embedsToggle(msg({ flags: MessageFlags.SUPPRESS_EMBEDS }), 'me', 0n)!.onClick?.(); expect(m.setFlags).toHaveBeenLastCalledWith('c', '9', 0);
  });
});
