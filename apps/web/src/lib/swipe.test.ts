import { describe, expect, it } from 'vitest';
import { DEFAULT_SWIPE, actionFor, classifySwipe, dragOffset, isHorizontalDrag, sanitizeSwipe } from './swipe';
import { markQuick } from './menus';

const all = { canReply: true, canReact: true, canEdit: true };

describe('swipe gesture mapping', () => {
  it('defaults: right replies, left reacts, and edit is not on either side', () => {
    expect(DEFAULT_SWIPE).toEqual({ swipeRight: 'reply', swipeLeft: 'react' });
    expect(actionFor('right', DEFAULT_SWIPE, all)).toBe('reply');
    expect(actionFor('left', DEFAULT_SWIPE, all)).toBe('react');
  });
  it('follows the configured actions, including none and edit', () => {
    expect(actionFor('left', { swipeRight: 'react', swipeLeft: 'edit' }, all)).toBe('edit');
    expect(actionFor('right', { swipeRight: 'none', swipeLeft: 'edit' }, all)).toBe('none');
  });
  it('refuses actions the viewer cannot do on that message (edit on someone else, reply without permission)', () => {
    expect(actionFor('left', { swipeRight: 'reply', swipeLeft: 'edit' }, { ...all, canEdit: false })).toBe('none');
    expect(actionFor('right', DEFAULT_SWIPE, { ...all, canReply: false })).toBe('none');
    expect(actionFor('left', DEFAULT_SWIPE, { ...all, canReact: false })).toBe('none');
  });
  it('sanitizes stored prefs', () => {
    expect(sanitizeSwipe({ swipeRight: 'bogus', swipeLeft: 'none' })).toEqual({ swipeRight: 'reply', swipeLeft: 'none' });
    expect(sanitizeSwipe(undefined)).toEqual(DEFAULT_SWIPE);
  });
  it('classifies a quick horizontal travel and ignores scrolls, short and slow drags', () => {
    expect(classifySwipe(90, 5, 200)).toBe('right');
    expect(classifySwipe(-90, -10, 200)).toBe('left');
    expect(classifySwipe(30, 0, 100)).toBeNull();
    expect(classifySwipe(90, 80, 200)).toBeNull();
    expect(classifySwipe(90, 0, 1500)).toBeNull();
  });
  it('treats mostly-vertical movement as scrolling', () => {
    expect(isHorizontalDrag(30, 5)).toBe(true);
    expect(isHorizontalDrag(30, 40)).toBe(false);
    expect(isHorizontalDrag(5, 0)).toBe(false);
  });
  it('damps the drag past the threshold', () => {
    expect(dragOffset(40)).toBe(40);
    expect(dragOffset(-200)).toBeLessThanOrEqual(-64);
    expect(Math.abs(dragOffset(-400))).toBeLessThanOrEqual(96);
  });
});

describe('long-press sheet quick actions', () => {
  const item = (label: string, extra: object = {}) => ({ label, onClick: () => {}, ...extra });
  it('flags at most six common actions without reordering the list', () => {
    const items = ['Add Reaction', 'Edit Message', 'Pin Message', 'Reply', 'Copy Text', 'Forward', 'Mark Unread', 'Copy Message Link'].map((l) => item(l));
    const out = markQuick(items);
    expect(out.map((i) => i.label)).toEqual(items.map((i) => i.label));
    expect(out.filter((i) => i.quick).map((i) => i.label).sort()).toEqual(['Add Reaction', 'Copy Text', 'Edit Message', 'Forward', 'Pin Message', 'Reply']);
  });
  it('skips disabled actions and caps at six', () => {
    const out = markQuick([item('Reply', { disabled: true }), item('Add Reaction'), item('Copy Text')]);
    expect(out.filter((i) => i.quick).map((i) => i.label)).toEqual(['Add Reaction', 'Copy Text']);
    expect(markQuick(['Reply', 'Add Reaction', 'Edit Message', 'Copy Text', 'Forward', 'Pin Message', 'Unpin Message'].map((l) => item(l))).filter((i) => i.quick)).toHaveLength(6);
  });
});
