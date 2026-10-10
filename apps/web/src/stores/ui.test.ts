import { describe, expect, it } from 'vitest';
import { errorText } from './ui';

describe('errorText', () => {
  it('prefers the first field-level validation message (Discord-style errors tree)', () => {
    expect(errorText({ message: 'Invalid form body', errors: { 'answers.0.text': { _errors: [{ message: 'Too long' }] } } })).toBe('answers.0.text: Too long');
  });
  it('falls back to the message, then a generic text', () => { expect(errorText(new Error('Nope'))).toBe('Nope'); expect(errorText(undefined)).toBe('Something went wrong'); expect(errorText({ message: 'x', errors: {} })).toBe('x'); });
});
