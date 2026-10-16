import { afterEach, describe, expect, it, vi } from 'vitest';
import { notificationPermission, permissionState, testNotification } from './push';

describe('notification permission state', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('normalises a raw permission value', () => {
    expect(permissionState('granted')).toBe('granted');
    expect(permissionState('denied')).toBe('denied');
    expect(permissionState('default')).toBe('default');
    expect(permissionState('something-else')).toBe('unsupported');
    expect(permissionState(undefined)).toBe('unsupported');
  });

  it('reads the live Notification permission, or reports unsupported when the API is missing', () => {
    vi.stubGlobal('Notification', { permission: 'denied' });
    expect(notificationPermission()).toBe('denied');
    vi.stubGlobal('Notification', undefined);
    expect(notificationPermission()).toBe('unsupported');
  });
});

describe('test notification copy', () => {
  it('is a stable title and body', () => {
    expect(testNotification()).toEqual({ title: 'Jorcord', body: 'Notifications are working.' });
  });
});
