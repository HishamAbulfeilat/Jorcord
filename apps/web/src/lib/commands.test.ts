import { describe, expect, it } from 'vitest';
import type { ApplicationCommand, CommandOption } from '@jorcord/shared';
import { autocompleteOptions, buildInteractionOptions, coerceValue, commandLabel, filterCommands, parseSlash, validateOptions, variantsOf } from './commands';

const cmd = (name: string, options: CommandOption[] = [], extra: Partial<ApplicationCommand> = {}): ApplicationCommand => ({ id: name, applicationId: 'app', guildId: null, type: 1, name, description: `${name} command`, options, defaultMemberPermissions: null, dmPermission: true, nsfw: false, version: '1', ...extra });
const opt = (name: string, type: number, extra: Partial<CommandOption> = {}): CommandOption => ({ name, type, description: name, ...extra });

describe('slash input', () => {
  it('parses the leading command and whether a space follows', () => {
    expect(parseSlash('/ping')).toEqual({ name: 'ping', rest: '', hasSpace: false });
    expect(parseSlash('/Ping ')).toEqual({ name: 'ping', rest: '', hasSpace: true });
    expect(parseSlash('/roll 2d6')).toEqual({ name: 'roll', rest: '2d6', hasSpace: true });
    expect(parseSlash('hello /ping')).toBeNull(); expect(parseSlash('/')).toEqual({ name: '', rest: '', hasSpace: false }); expect(parseSlash('//')).toBeNull();
  });
  it('ranks exact > prefix > substring, hides user/message commands, and caps the list', () => {
    const list = [cmd('background'), cmd('ban'), cmd('b'), cmd('ping'), cmd('Avatar', [], { type: 2 }), cmd('web')];
    expect(filterCommands(list, 'b').map((c) => c.name)).toEqual(['b', 'background', 'ban', 'web']);
    expect(filterCommands(list, '').map((c) => c.name)).toEqual(['background', 'ban', 'b', 'ping', 'web']);
    expect(filterCommands(list, 'zzz')).toEqual([]);
    expect(filterCommands(Array.from({ length: 30 }, (_, i) => cmd('c' + i)), 'c', 5)).toHaveLength(5);
  });
});

describe('variants and payloads', () => {
  const tree = cmd('settings', [
    opt('view', 1, { options: [opt('verbose', 5)] }),
    opt('user', 2, { options: [opt('set', 1, { options: [opt('name', 3, { required: true }), opt('age', 4)] }), opt('reset', 1)] }),
  ]);
  it('a plain command is one variant; groups flatten to "group sub" leaves', () => {
    expect(variantsOf(cmd('ping')).map((v) => v.label)).toEqual(['']);
    expect(variantsOf(tree).map((v) => v.path)).toEqual([['view'], ['user', 'set'], ['user', 'reset']]);
    expect(commandLabel(tree, variantsOf(tree)[1])).toBe('/settings user set');
  });
  it('builds nested group > sub > option data with coerced values and skips empty ones', () => {
    const v = variantsOf(tree)[1]!;
    expect(buildInteractionOptions(v, { name: 'Ada', age: '36' })).toEqual([{ name: 'user', type: 2, options: [{ name: 'set', type: 1, options: [{ name: 'name', type: 3, value: 'Ada' }, { name: 'age', type: 4, value: 36 }] }] }]);
    expect(buildInteractionOptions(v, { name: 'Ada', age: '' })[0]!.options![0]!.options).toEqual([{ name: 'name', type: 3, value: 'Ada' }]);
    expect(buildInteractionOptions(variantsOf(cmd('ping'))[0]!, {})).toEqual([]);
  });
  it('coerces by option type', () => {
    expect(coerceValue({ type: 4 }, '7.9')).toBe(7); expect(coerceValue({ type: 10 }, '7.5')).toBe(7.5); expect(coerceValue({ type: 5 }, 'true')).toBe(true); expect(coerceValue({ type: 5 }, false)).toBe(false); expect(coerceValue({ type: 6 }, 123)).toBe('123');
  });
  it('autocomplete data flags the focused option and keeps the others', () => {
    const c = cmd('tag', [opt('category', 3, { required: true }), opt('name', 3, { autocomplete: true })]);
    expect(autocompleteOptions(variantsOf(c)[0]!, { category: 'x', name: 'ab' }, 'name')).toEqual([{ name: 'category', type: 3, value: 'x' }, { name: 'name', type: 3, value: 'ab', focused: true }]);
  });
});

describe('validateOptions', () => {
  const options = [opt('text', 3, { required: true, minLength: 2, maxLength: 4 }), opt('n', 4, { minValue: 1, maxValue: 10 }), opt('f', 10), opt('file', 11, { required: true })];
  it('requires, bounds and type-checks', () => {
    expect(validateOptions(options, {})).toEqual({ text: 'This field is required', file: 'Attachments cannot be sent from the web client yet' });
    expect(validateOptions(options.slice(0, 3), { text: 'a' }).text).toMatch(/at least 2/);
    expect(validateOptions(options.slice(0, 3), { text: 'abcde' }).text).toMatch(/at most 4/);
    expect(validateOptions(options.slice(0, 3), { text: 'ok', n: 11 }).n).toMatch(/at most 10/);
    expect(validateOptions(options.slice(0, 3), { text: 'ok', n: 1.5 }).n).toMatch(/whole/);
    expect(validateOptions(options.slice(0, 3), { text: 'ok', f: 'abc' }).f).toMatch(/number/);
    expect(validateOptions(options.slice(0, 3), { text: 'ok', n: 3, f: 2.5 })).toEqual({});
  });
});
