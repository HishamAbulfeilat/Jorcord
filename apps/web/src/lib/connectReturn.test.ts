import { describe, expect, it } from 'vitest';
import { connectReturnMessage, parseConnectReturn, stripConnectReturn } from './connectReturn';

describe('connect return', () => {
  it('parses only well-formed provider/result pairs', () => {
    expect(parseConnectReturn('?connect=twitch&result=ok')).toEqual({ provider: 'twitch', result: 'ok' });
    expect(parseConnectReturn('?connect=youtube&result=already_linked')).toEqual({ provider: 'youtube', result: 'already_linked' });
    for (const bad of ['', '?connect=twitch', '?result=ok', '?connect=Twi tch&result=ok', '?connect=twitch&result=<script>', '?connect=a&result=ok']) expect(parseConnectReturn(bad), bad).toBeNull();
  });
  it('removes the params and keeps the rest', () => {
    expect(stripConnectReturn('?connect=twitch&result=ok')).toBe('');
    expect(stripConnectReturn('?a=1&connect=twitch&result=ok')).toBe('?a=1');
  });
  it('words success and each failure, with a generic fallback', () => {
    expect(connectReturnMessage({ provider: 'twitch', result: 'ok' })).toEqual({ text: 'Twitch connected and verified', kind: 'success' });
    expect(connectReturnMessage({ provider: 'youtube', result: 'already_linked' }).text).toContain('already connected');
    expect(connectReturnMessage({ provider: 'youtube', result: 'no_channel' }).kind).toBe('error');
    expect(connectReturnMessage({ provider: 'twitch', result: 'exchange_failed' }).text).toContain('Could not connect Twitch');
    expect(connectReturnMessage({ provider: 'twitch', result: 'whatever' }).kind).toBe('error');
  });
});
