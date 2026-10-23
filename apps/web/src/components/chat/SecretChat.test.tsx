import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { Channel, Message } from '@jorcord/shared';
import { useData } from '@/stores/data';
import { useUI } from '@/stores/ui';
import { useSecret } from '@/stores/secret';

const svc = vi.hoisted(() => ({ loadChannelCrypto: vi.fn(), openMessage: vi.fn(), acceptKeys: vi.fn(), forgetLocalDevice: vi.fn() }));
vi.mock('@/lib/e2ee/service', () => svc);
vi.mock('@/lib/api', () => ({ api: {} }));
import { MessageText, SafetyNumberModal, SecretBar } from './SecretChat';

const me = { id: 'me', username: 'me' };
const peer = { id: 'peer', username: 'pia', displayName: 'Pia' };
const secretCh = { id: 'sc', guildId: null, type: 'dm', encrypted: true, recipients: [me, peer] } as unknown as Channel;
const plainCh = { id: 'pc', guildId: null, type: 'dm', recipients: [me, peer] } as unknown as Channel;
const msg = (id: string, channelId: string, content: string) => ({ id, channelId, content, type: 'default', author: peer, guildId: null } as unknown as Message);
const cc = (over: Record<string, unknown> = {}) => ({
  channelId: 'sc', peerId: 'peer', me: { deviceId: 'd1' }, known: new Map(), mine: [{ id: 'd1', label: 'This browser', fp: 'aa'.repeat(32) }], theirs: [{ id: 'd2', label: 'Pia phone', fp: 'bb'.repeat(32) }],
  safety: '11111 22222 33333 44444\n55555 66666 77777 88888\n99999 00000 12345 67890', trust: { status: 'ok', added: [], changed: [], removed: [] }, verified: false, persistent: true, ...over,
});

beforeEach(() => {
  useData.setState({ me: me as never, dms: { sc: secretCh, pc: plainCh } });
  useUI.setState({ toasts: [] });
  useSecret.setState({ cc: {}, error: {}, opened: {} });
  Object.values(svc).forEach((f) => f.mockReset());
});
const view = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);
afterEach(cleanup);

describe('MessageText', () => {
  it('renders normal messages as before, even if they look like an envelope', () => {
    view(<MessageText m={msg('1', 'pc', 'jc-e2ee1:hello **there**')} />);
    expect(screen.queryByTestId('secret-pending')).toBeNull();
    expect(screen.getByText(/jc-e2ee1:hello/)).toBeTruthy();
    expect(svc.openMessage).not.toHaveBeenCalled();
  });

  it('shows the decrypted text of a secret chat message, never the ciphertext', async () => {
    svc.loadChannelCrypto.mockResolvedValue(cc());
    svc.openMessage.mockResolvedValue({ ok: true, plaintext: 'see you at **noon**', fromDevice: 'd2' });
    view(<MessageText m={msg('2', 'sc', 'jc-e2ee1:AAAA')} />);
    expect(screen.getByTestId('secret-pending')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('secret-text').textContent).toBe('see you at noon'));
    expect(screen.queryByText(/jc-e2ee1/)).toBeNull();
  });

  it('says why a message cannot be opened instead of showing garbage', async () => {
    svc.loadChannelCrypto.mockResolvedValue(cc());
    svc.openMessage.mockResolvedValue({ ok: false, reason: 'authentication_failed' });
    view(<MessageText m={msg('3', 'sc', 'jc-e2ee1:AAAA')} />);
    await waitFor(() => expect(screen.getByTestId('secret-failed').textContent).toMatch(/failed verification/));
  });

  it('reports missing keys when they cannot be loaded', async () => {
    svc.loadChannelCrypto.mockRejectedValue(new Error('offline'));
    view(<MessageText m={msg('4', 'sc', 'jc-e2ee1:AAAA')} />);
    await waitFor(() => expect(screen.getByTestId('secret-failed').textContent).toMatch(/could not be loaded/));
  });
});

describe('SecretBar', () => {
  it('is absent in a normal DM and explains the limits in a secret chat', async () => {
    const { container } = view(<SecretBar channelId="pc" />);
    expect(container.firstChild).toBeNull();
    svc.loadChannelCrypto.mockResolvedValue(cc());
    view(<SecretBar channelId="sc" />);
    await waitFor(() => expect(screen.getByTestId('secret-bar').textContent).toMatch(/End-to-end encrypted/));
    expect(screen.getByTestId('secret-bar').textContent).toMatch(/No link previews, search, attachments or edits/);
  });

  it('turns into an alert after a key change and opens the safety number dialog', async () => {
    svc.loadChannelCrypto.mockResolvedValue(cc({ trust: { status: 'changed', added: ['d3'], changed: [], removed: [] } }));
    view(<SecretBar channelId="sc" />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/security keys changed/));
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(useUI.getState().modal).toMatchObject({ kind: 'safetyNumber', channelId: 'sc' });
  });

  it('warns when the other person has no device yet and when keys cannot be stored', async () => {
    svc.loadChannelCrypto.mockResolvedValue(cc({ theirs: [], persistent: false }));
    view(<SecretBar channelId="sc" />);
    await waitFor(() => expect(screen.getByTestId('secret-bar').textContent).toMatch(/not set up secret chats/));
    expect(screen.getByTestId('secret-bar').textContent).toMatch(/cannot store keys/);
  });
});

describe('SafetyNumberModal', () => {
  it('shows the number and lets the user mark it verified', async () => {
    svc.loadChannelCrypto.mockResolvedValue(cc());
    svc.acceptKeys.mockResolvedValue(undefined);
    const close = vi.fn();
    view(<SafetyNumberModal channelId="sc" close={close} />);
    await waitFor(() => expect(screen.getByTestId('safety-number').textContent).toContain('11111 22222 33333 44444'));
    fireEvent.click(screen.getByRole('button', { name: /Mark as verified/ }));
    await waitFor(() => expect(svc.acceptKeys).toHaveBeenCalledWith(expect.anything(), 'me', { verified: true }));
    await waitFor(() => expect(close).toHaveBeenCalled());
  });

  it('after a key change only offers to accept the new keys, with a warning', async () => {
    svc.loadChannelCrypto.mockResolvedValue(cc({ trust: { status: 'changed', added: ['d3'], changed: ['d2'], removed: [] } }));
    svc.acceptKeys.mockResolvedValue(undefined);
    view(<SafetyNumberModal channelId="sc" close={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Pia's security keys changed \(2 new or replaced\)/));
    expect(screen.queryByRole('button', { name: /Mark as verified/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Accept new keys' }));
    await waitFor(() => expect(svc.acceptKeys).toHaveBeenCalledWith(expect.anything(), 'me', { verified: false }));
  });
});
