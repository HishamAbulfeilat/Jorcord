import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageFlags, Perm, snowflake } from '@jorcord/shared';
import { parseMarkdown, toPlain } from './markdown';
import { parseSearchTokens, resolveChannel, toSearchRequest } from './searchTokens';
import { parseSendOptions, isTtsCommand } from './composerCommands';
import { loadDraft, saveDraft, clearDrafts } from './drafts';
import { bypassesSlowmode, fmtSlowmode, slowmodeRemaining } from './slowmode';
import { shouldSpeak, speak } from './tts';

describe('subtext and nested lists', () => {
  it('-# is a subtext line, not a list', () => {
    const n = parseMarkdown('-# small print **bold**\nnormal');
    expect(n[0]).toMatchObject({ t: 'subtext' });
    expect(toPlain((n[0] as any).c)).toBe('small print bold');
    expect(n.some((x) => x.t === 'list')).toBe(false);
    expect(parseMarkdown('-#nospace')[0]).toMatchObject({ t: 'text' });
    expect(parseMarkdown('- item')[0]).toMatchObject({ t: 'list' });
  });
  it('two-space indented items nest one level under the previous item', () => {
    const l = parseMarkdown('- a\n  - a1\n  - a2\n- b\n  1. b1')[0] as any;
    expect(l.t).toBe('list'); expect(l.items).toHaveLength(2);
    const sub = l.items[0].find((x: any) => x.t === 'list');
    expect(sub.ordered).toBe(false); expect(sub.items).toHaveLength(2);
    expect(toPlain(sub.items[1])).toBe('a2');
    const sub2 = l.items[1].find((x: any) => x.t === 'list');
    expect(sub2.ordered).toBe(true); expect(toPlain(sub2.items[0])).toBe('b1');
  });
  it('deeper indentation folds into the second level; a lone indented bullet stays text', () => {
    const l = parseMarkdown('- a\n  - b\n    - c')[0] as any;
    const sub = l.items[0].find((x: any) => x.t === 'list');
    expect(sub.items).toHaveLength(2);
    expect(parseMarkdown('  - lonely')[0]).toMatchObject({ t: 'text' });
  });
  it('toPlain flattens nested lists', () => {
    expect(toPlain(parseMarkdown('- a\n  - b')).replace(/\s+/g, ' ')).toBe('a b');
  });
});

describe('in: and author_type: search tokens', () => {
  const chans = [{ id: '501', name: 'general' }, { id: '502', name: 'Dev-Chat' }];
  it('parses in: (name, #name, <#id>, id) and author_type:', () => {
    expect(parseSearchTokens('hello in:#general author_type:bot')).toMatchObject({ text: 'hello', inChannel: ['general'], authorType: 'bot' });
    expect(parseSearchTokens('in:<#502>').inChannel).toEqual(['502']);
    expect(parseSearchTokens('x in:502').inChannel).toEqual(['502']);
    expect(parseSearchTokens('author_type:USER').authorType).toBe('user');
  });
  it('keeps an invalid author_type as plain text', () => {
    const p = parseSearchTokens('author_type:robot hi');
    expect(p.authorType).toBeUndefined(); expect(p.text).toBe('author_type:robot hi');
  });
  it('resolves channels case-insensitively and reports unknown ones', () => {
    expect(resolveChannel('dev-chat', chans)).toBe('502');
    expect(resolveChannel('999', chans)).toBe('999');
    expect(resolveChannel('nope', chans)).toBeNull();
    const ok = toSearchRequest(parseSearchTokens('hi in:#Dev-Chat author_type:user'), [], chans);
    expect(ok.req).toMatchObject({ q: 'hi', channelId: '502', author_type: 'user' }); expect(ok.unresolved).toEqual([]);
    expect(toSearchRequest(parseSearchTokens('in:#ghost'), [], chans).unresolved).toEqual(['#ghost']);
  });
});

describe('composer send options (@silent, no-embeds, /tts)', () => {
  it('a leading @silent is stripped and sets 1<<12', () => {
    expect(parseSendOptions('@silent hello there')).toEqual({ content: 'hello there', flags: MessageFlags.SUPPRESS_NOTIFICATIONS });
    expect(parseSendOptions('hello @silent')).toEqual({ content: 'hello @silent', flags: 0 });
  });
  it('toggles add flags', () => {
    expect(parseSendOptions('hi', { silent: true, noEmbeds: true }).flags).toBe(MessageFlags.SUPPRESS_NOTIFICATIONS | MessageFlags.SUPPRESS_EMBEDS);
  });
  it('/tts needs SEND_TTS and text', () => {
    expect(parseSendOptions('/tts good morning', { canTts: true })).toEqual({ content: 'good morning', flags: MessageFlags.TTS });
    expect(parseSendOptions('/tts hi', { canTts: false })).toMatchObject({ ttsDenied: true });
    expect(parseSendOptions('/tts   ', { canTts: true })).toMatchObject({ ttsEmpty: true });
    expect(parseSendOptions('@silent /tts psst', { canTts: true }).flags).toBe(MessageFlags.TTS | MessageFlags.SUPPRESS_NOTIFICATIONS);
    expect(parseSendOptions('/ttsx hi', { canTts: true })).toEqual({ content: '/ttsx hi', flags: 0 });
    expect(isTtsCommand('/tts hi')).toBe(true); expect(isTtsCommand('/ttsx')).toBe(false);
    expect(Perm.SEND_TTS).toBe(1n << 12n);
  });
});

describe('persistent drafts', () => {
  beforeEach(() => localStorage.clear());
  it('round-trips per channel and account, and clears on empty', () => {
    saveDraft('u1', 'c1', 'half written'); saveDraft('u1', 'c2', 'other');
    expect(loadDraft('u1', 'c1')).toBe('half written'); expect(loadDraft('u1', 'c2')).toBe('other');
    expect(loadDraft('u2', 'c1')).toBe(''); // another account never sees it
    saveDraft('u1', 'c1', ''); // cleared on send
    expect(loadDraft('u1', 'c1')).toBe(''); expect(loadDraft('u1', 'c2')).toBe('other');
    saveDraft('u1', 'c2', '   '); expect(localStorage.getItem('jorcord.drafts.v1')).toBeNull();
  });
  it('caps stored drafts at 100, dropping the oldest', () => {
    for (let i = 0; i < 105; i++) saveDraft('u1', `c${i}`, 'x', i);
    expect(loadDraft('u1', 'c0')).toBe(''); expect(loadDraft('u1', 'c104')).toBe('x');
    expect(Object.keys(JSON.parse(localStorage.getItem('jorcord.drafts.v1')!).items)).toHaveLength(100);
  });
  it('survives broken or unavailable storage', () => {
    localStorage.setItem('jorcord.drafts.v1', '{not json');
    expect(loadDraft('u1', 'c1')).toBe(''); expect(() => saveDraft('u1', 'c1', 'ok')).not.toThrow(); expect(loadDraft('u1', 'c1')).toBe('ok');
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(() => saveDraft('u1', 'c3', 'x')).not.toThrow(); spy.mockRestore();
    clearDrafts(); expect(loadDraft('u1', 'c1')).toBe('');
  });
});

describe('slowmode countdown', () => {
  const at = (ms: number) => snowflake(ms);
  it('counts down from the last own message and expires', () => {
    const t0 = Date.parse('2026-05-01T12:00:00Z');
    const id = at(t0);
    expect(slowmodeRemaining({ slowmode: 10, lastOwnMessageId: id, now: t0 + 2_500 })).toBe(8);
    expect(slowmodeRemaining({ slowmode: 10, lastOwnMessageId: id, now: t0 + 10_000 })).toBe(0);
    expect(slowmodeRemaining({ slowmode: 0, lastOwnMessageId: id, now: t0 })).toBe(0);
    expect(slowmodeRemaining({ slowmode: 10, now: t0 })).toBe(0);
  });
  it('a client deadline (after a send or a 429) wins when later', () => {
    const t0 = Date.parse('2026-05-01T12:00:00Z');
    expect(slowmodeRemaining({ slowmode: 5, lastOwnMessageId: at(t0 - 60_000), until: t0 + 3_200, now: t0 })).toBe(4);
  });
  it('is skipped for BYPASS_SLOWMODE, MANAGE_CHANNELS and MANAGE_MESSAGES', () => {
    const t0 = Date.now();
    expect(slowmodeRemaining({ slowmode: 30, lastOwnMessageId: at(t0), now: t0, bypass: true })).toBe(0);
    expect(bypassesSlowmode(Perm.BYPASS_SLOWMODE)).toBe(true); expect(bypassesSlowmode(Perm.MANAGE_CHANNELS)).toBe(true);
    expect(bypassesSlowmode(Perm.MANAGE_MESSAGES)).toBe(true); expect(bypassesSlowmode(Perm.SEND_MESSAGES)).toBe(false);
  });
  it('formats the label', () => { expect(fmtSlowmode(42)).toBe('42s'); expect(fmtSlowmode(65)).toBe('1:05'); });
});

describe('/tts playback gating', () => {
  const base = { flags: MessageFlags.TTS, mine: false, allowed: true, inCall: false };
  it('speaks only when flagged, opted in, not mine and not in a call', () => {
    expect(shouldSpeak(base)).toBe(true);
    expect(shouldSpeak({ ...base, allowed: false })).toBe(false); // the setting is off by default
    expect(shouldSpeak({ ...base, mine: true })).toBe(false);
    expect(shouldSpeak({ ...base, inCall: true })).toBe(false);
    expect(shouldSpeak({ ...base, flags: 0 })).toBe(false);
  });
  describe('speech synthesis', () => {
    const spoken: string[] = [];
    beforeEach(() => {
      spoken.length = 0;
      vi.stubGlobal('SpeechSynthesisUtterance', class { text: string; lang = ''; onend: (() => void) | null = null; onerror: (() => void) | null = null; constructor(t: string) { this.text = t; } });
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { speak: (u: any) => { spoken.push(u.text); } } });
    });
    afterEach(() => { vi.unstubAllGlobals(); delete (window as any).speechSynthesis; });
    it('uses the Web Speech API and caps the queue', () => {
      expect(speak('hello')).toBe(true); expect(speak('a')).toBe(true); expect(speak('b')).toBe(true);
      expect(speak('c')).toBe(false); // queue full: onend never fired in this fake
      expect(spoken).toEqual(['hello', 'a', 'b']);
    });
  });
});
