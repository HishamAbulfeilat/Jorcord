import { describe, expect, it } from 'vitest';
import { isJumbo, parseInline, parseMarkdown, toPlain, firstUrl } from './markdown';

describe('markdown inline', () => {
  it('parses bold/italic/underline/strike', () => {
    expect(parseInline('**a**')).toEqual([{ t: 'bold', c: [{ t: 'text', v: 'a' }] }]);
    expect(parseInline('*a*')).toEqual([{ t: 'italic', c: [{ t: 'text', v: 'a' }] }]);
    expect(parseInline('_a_')).toEqual([{ t: 'italic', c: [{ t: 'text', v: 'a' }] }]);
    expect(parseInline('__a__')).toEqual([{ t: 'underline', c: [{ t: 'text', v: 'a' }] }]);
    expect(parseInline('~~a~~')).toEqual([{ t: 'strike', c: [{ t: 'text', v: 'a' }] }]);
  });
  it('handles nesting and bold-italic', () => {
    expect(parseInline('***x***')).toEqual([{ t: 'bold', c: [{ t: 'italic', c: [{ t: 'text', v: 'x' }] }] }]);
    expect(parseInline('**a *b* c**')).toEqual([{ t: 'bold', c: [{ t: 'text', v: 'a ' }, { t: 'italic', c: [{ t: 'text', v: 'b' }] }, { t: 'text', v: ' c' }] }]);
  });
  it('does not treat snake_case or lone asterisks as formatting', () => {
    expect(parseInline('snake_case_word')).toEqual([{ t: 'text', v: 'snake_case_word' }]);
    expect(parseInline('2 * 3 = 6')).toEqual([{ t: 'text', v: '2 * 3 = 6' }]);
  });
  it('escapes', () => { expect(parseInline('\\*no\\*')).toEqual([{ t: 'text', v: '*no*' }]); });
  it('inline code is verbatim', () => { expect(parseInline('`**x**`')).toEqual([{ t: 'code', v: '**x**' }]); });
  it('spoilers', () => { expect(parseInline('||s||')).toEqual([{ t: 'spoiler', c: [{ t: 'text', v: 's' }] }]); });
  it('mentions, channels, roles, emoji, time', () => {
    expect(parseInline('<@123> <@!4> <@&5> <#6>').filter((n) => n.t !== 'text')).toEqual([
      { t: 'user', id: '123' }, { t: 'user', id: '4' }, { t: 'role', id: '5' }, { t: 'channel', id: '6' }]);
    expect(parseInline('<a:wave:99>')).toEqual([{ t: 'emoji', name: 'wave', id: '99', animated: true }]);
    expect(parseInline('<t:1700000000:R>')).toEqual([{ t: 'time', ts: 1700000000, style: 'R' }]);
    expect(parseInline('@everyone')).toEqual([{ t: 'everyone', v: 'everyone' }]);
  });
  it('links: autolink trims punctuation, masked, suppressed', () => {
    expect(parseInline('see https://a.com/x.')).toEqual([{ t: 'text', v: 'see ' }, { t: 'link', href: 'https://a.com/x', c: [{ t: 'text', v: 'https://a.com/x' }], masked: false }, { t: 'text', v: '.' }]);
    expect(parseInline('[hi](https://a.com)')[0]).toMatchObject({ t: 'link', href: 'https://a.com', masked: true });
    expect(firstUrl(parseInline('x <https://b.com>'))).toBe('https://b.com');
  });
});

describe('markdown blocks', () => {
  it('code blocks with language', () => {
    expect(parseMarkdown('```ts\nconst a = 1;\n```')).toEqual([{ t: 'codeblock', lang: 'ts', v: 'const a = 1;' }]);
  });
  it('code block without language', () => {
    expect(parseMarkdown('```hello```')).toEqual([{ t: 'codeblock', lang: '', v: 'hello' }]);
  });
  it('text around code blocks', () => {
    const n = parseMarkdown('before\n```\nx\n```\nafter');
    expect(n.map((x) => x.t)).toEqual(['text', 'codeblock', 'text']);
  });
  it('quotes single and multi', () => {
    expect(parseMarkdown('> hi')[0]).toMatchObject({ t: 'quote' });
    const q = parseMarkdown('>>> a\nb\nc')[0] as any;
    expect(q.t).toBe('quote'); expect(toPlain(q.c)).toBe('a\nb\nc');
  });
  it('headings and lists', () => {
    expect(parseMarkdown('# T')[0]).toMatchObject({ t: 'heading', level: 1 });
    const l = parseMarkdown('- a\n- b')[0] as any; expect(l.items).toHaveLength(2);
    expect((parseMarkdown('1. a\n2. b')[0] as any).ordered).toBe(true);
  });
});

describe('helpers', () => {
  it('jumbo detection', () => {
    expect(isJumbo(parseInline('😀 😀'))).toBe(true);
    expect(isJumbo(parseInline('<:aa:1>'))).toBe(true);
    expect(isJumbo(parseInline('hi 😀'))).toBe(false);
  });
  it('toPlain resolves mentions', () => {
    expect(toPlain(parseInline('hey <@1>'), { user: () => 'bob' })).toBe('hey @bob');
  });
});
