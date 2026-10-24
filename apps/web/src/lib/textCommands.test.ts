import { describe, expect, it } from 'vitest';
import { expandTextCommand } from './textCommands';
import { parseMarkdown, toPlain } from './markdown';

describe('built-in text commands', () => {
  it('expands /me into an italic action', () => {
    expect(expandTextCommand('/me waves hello')).toBe('_waves hello_');
    expect(expandTextCommand('/ME waves')).toBe('_waves_');
    expect(expandTextCommand('/me snake_case')).toBe('_snake\\_case_');
    expect(expandTextCommand('/me')).toBe('/me');
  });
  it('appends the faces for /shrug /tableflip /unflip', () => {
    expect(expandTextCommand('/tableflip')).toBe('(╯°□°)╯︵ ┻━┻');
    expect(expandTextCommand('/tableflip so mad')).toBe('so mad (╯°□°)╯︵ ┻━┻');
    expect(expandTextCommand('/unflip')).toBe('┬─┬ ノ( ゜-゜ノ)');
    expect(expandTextCommand('/shrug idk')).toBe('idk ¯\\\\\\_(ツ)\\_/¯');
  });
  it('leaves everything else alone', () => {
    for (const s of ['/shrugging', 'hello /shrug', '/ping', '//me hi', ' /me hi', 'shrug', '/mex']) expect(expandTextCommand(s)).toBe(s);
  });
  it('the shrug survives markdown rendering', () => {
    expect(toPlain(parseMarkdown(expandTextCommand('/shrug')))).toBe('¯\\_(ツ)_/¯');
  });
});
