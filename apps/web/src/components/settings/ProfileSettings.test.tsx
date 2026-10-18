import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/api', () => ({
  api: {
    admin: { me: vi.fn().mockRejectedValue(new Error('no')) },
    users: { patchMe: vi.fn() },
    files: { uploadImage: vi.fn(), uploadImageFromUrl: vi.fn() },
  },
}));
vi.mock('@/voice/VoiceSettings', () => ({ VoiceSettingsForm: () => null }));

import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { useUI } from '@/stores/ui';
import { UserSettings } from './UserSettings';

const patchMe = vi.mocked(api.users.patchMe);
const upload = vi.mocked(api.files.uploadImage);
const fromUrl = vi.mocked(api.files.uploadImageFromUrl);

const me: any = { id: 'u1', username: 'me', displayName: 'Me', email: 'a@b.c', verified: true, avatar: null, banner: '/api/v1/files/b/banner.gif', bio: 'hi', pronouns: null, themeColors: null, accentColor: '#5865f2', avatarDecoration: null, profileEffect: null, namePlate: null, serverTag: null, customStatus: null, createdAt: new Date().toISOString() };

const mount = () => render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><UserSettings initialTab="profile" /></MemoryRouter></QueryClientProvider>);
const save = async (body: object) => { fireEvent.click(await screen.findByText('Save Changes')); await waitFor(() => expect(patchMe).toHaveBeenCalledWith(expect.objectContaining(body))); };

beforeEach(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false })) as never;
  patchMe.mockReset().mockImplementation(async (b: any) => ({ ...me, ...b }) as never);
  upload.mockReset(); fromUrl.mockReset();
  useData.setState({ ready: true, me, guilds: {}, guildOrder: [], users: {}, presences: {} } as never);
  useUI.setState({ modal: null } as never);
});
afterEach(cleanup);

describe('Profile settings controls', () => {
  it('saves display name, pronouns and About Me, shows them live in the preview, and updates the store', async () => {
    mount();
    fireEvent.change(screen.getByLabelText('Display Name'), { target: { value: 'Neo' } });
    fireEvent.change(screen.getByLabelText('Pronouns'), { target: { value: 'he/him' } });
    fireEvent.change(screen.getByLabelText(/About Me/), { target: { value: 'I **code**' } });
    expect(screen.getByTestId('preview-name').textContent).toContain('Neo');
    await save({ displayName: 'Neo', pronouns: 'he/him', bio: 'I **code**' });
    await waitFor(() => expect(useData.getState().me!.displayName).toBe('Neo'));
  });

  it('uploads a GIF avatar from disk and sends the stored URL on save', async () => {
    upload.mockResolvedValue('/api/v1/files/k/me.gif');
    mount();
    const input = document.querySelector('input[type=file]') as HTMLInputElement; // the avatar picker comes first
    expect(input.accept).toBe('image/*');
    fireEvent.change(input, { target: { files: [new File([new Uint8Array([71, 73, 70])], 'me.gif', { type: 'image/gif' })] } });
    await waitFor(() => expect(upload).toHaveBeenCalled());
    await save({ avatar: '/api/v1/files/k/me.gif' });
  });

  it('Choose GIF (avatar) opens the GIF search, re-hosts the pick through the server and saves it', async () => {
    fromUrl.mockResolvedValue('/api/v1/files/z/avatar.gif');
    mount();
    fireEvent.click(screen.getAllByText('Choose GIF')[0]!);
    const m = useUI.getState().modal as any;
    expect(m.kind).toBe('gifPicker');
    m.onPick('https://media.giphy.com/cat.gif');
    await waitFor(() => expect(fromUrl).toHaveBeenCalledWith('avatar', 'https://media.giphy.com/cat.gif'));
    await save({ avatar: '/api/v1/files/z/avatar.gif' });
  });

  it('Choose GIF (banner) and Remove banner both change the saved banner', async () => {
    fromUrl.mockResolvedValue('/api/v1/files/z/banner.gif');
    mount();
    fireEvent.click(screen.getAllByText('Choose GIF')[1]!);
    (useUI.getState().modal as any).onPick('https://media.giphy.com/b.gif');
    await waitFor(() => expect(fromUrl).toHaveBeenCalledWith('banner', 'https://media.giphy.com/b.gif'));
    await save({ banner: '/api/v1/files/z/banner.gif' });
    cleanup(); patchMe.mockClear(); mount();
    fireEvent.click(screen.getByText('Remove banner'));
    await save({ banner: null });
  });

  it('applies the profile theme, a two-colour gradient and removes it again', async () => {
    mount();
    fireEvent.click(screen.getByRole('radio', { name: 'Sunset' }));
    await save({ accentColor: '#f0552b' });
    fireEvent.click(screen.getByText('Remove banner')); // a banner image would cover the gradient
    fireEvent.click(screen.getByRole('radio', { name: 'Aurora' }));
    expect(screen.getByTestId('preview-banner').getAttribute('style')).toContain('linear-gradient');
    await save({ themeColors: ['#5865f2', '#3ba55d'] });
    fireEvent.click(screen.getByText('Remove gradient'));
    await waitFor(() => expect(screen.queryByText('Remove gradient')).toBeNull());
  });

  it('picks an avatar decoration, profile effect and name plate (each can be cleared)', async () => {
    mount();
    const group = (label: string) => screen.getByRole('radiogroup', { name: label });
    const first = (label: string) => group(label).querySelectorAll<HTMLElement>('[role=radio]')[1]!;
    const dec = first('Avatar Decoration'), eff = first('Profile Effect'), plate = first('Name Plate');
    fireEvent.click(dec); fireEvent.click(eff); fireEvent.click(plate);
    expect(dec.getAttribute('aria-checked')).toBe('true');
    await save({ avatarDecoration: dec.getAttribute('aria-label') ? expect.any(String) : null, profileEffect: expect.any(String), namePlate: expect.any(String) });
    fireEvent.click(group('Name Plate').querySelectorAll<HTMLElement>('[role=radio]')[0]!);
    await save({ namePlate: null });
  });

  it('Reset discards unsaved edits and the custom status button opens its dialog', () => {
    mount();
    const name = screen.getByLabelText('Display Name') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Zed' } });
    fireEvent.click(screen.getByText('Reset'));
    expect(name.value).toBe('Me');
    fireEvent.click(screen.getByText('Set a custom status'));
    expect((useUI.getState().modal as any).kind).toBe('customStatus');
  });

  it('uploads a banner image and saves the stored URL', async () => {
    upload.mockResolvedValue('/api/v1/files/k/banner.png');
    mount();
    const inputs = document.querySelectorAll<HTMLInputElement>('input[type=file]');
    fireEvent.change(inputs[1]!, { target: { files: [new File([new Uint8Array([137, 80, 78, 71])], 'banner.png', { type: 'image/png' })] } });
    await waitFor(() => expect(upload).toHaveBeenCalled());
    await save({ banner: '/api/v1/files/k/banner.png' });
  });

  it('removes the avatar through the picker and saves null', async () => {
    useData.setState((s) => ({ me: { ...(s.me as any), avatar: '/api/v1/files/k/a.png' } }) as never);
    mount();
    fireEvent.click(screen.getByText('Remove'));
    await save({ avatar: null });
  });

  it('wears a server tag chosen in the cosmetics picker and saves it with the profile', async () => {
    useData.setState({
      guilds: { g1: { guild: { id: 'g1', name: 'Tagged', tag: 'TAG', tagBadge: 'flame' }, channels: {}, roles: {}, members: {}, emojis: [], stickers: [], memberCount: 1 } },
      guildOrder: ['g1'],
    } as never);
    mount();
    fireEvent.click(screen.getByRole('radio', { name: 'Tagged tag TAG' }));
    await save({ serverTagGuildId: 'g1' });
  });
});
