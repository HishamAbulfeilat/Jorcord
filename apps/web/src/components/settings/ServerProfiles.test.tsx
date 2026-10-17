import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({ api: { guilds: { patchMember: vi.fn() }, files: { uploadImage: vi.fn(), uploadImageFromUrl: vi.fn() } } }));
vi.mock('@/components/modals/ModalHost', () => ({ IconPicker: () => null }));
vi.mock('@/components/chat/Markdown', () => ({ Markdown: ({ content }: { content: string }) => <span data-testid="md">{content}</span> }));

import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { useUI } from '@/stores/ui';
import { ServerProfiles } from './ServerProfiles';

const patchMember = vi.mocked(api.guilds.patchMember);

const me: any = { id: 'u1', username: 'me', displayName: 'Me', avatar: null, banner: null, bio: 'global bio', pronouns: 'they/them', themeColors: null, accentColor: '#5865f2', avatarDecoration: null };
const member: any = { guildId: 'g1', user: me, nick: 'Old Nick', roles: [], joinedAt: new Date().toISOString(), timeoutUntil: null, avatar: null, banner: null, bio: null, pronouns: null };

beforeEach(() => {
  patchMember.mockReset();
  useData.setState({
    ready: true, me,
    guilds: { g1: { guild: { id: 'g1', name: 'Test Server' } as any, channels: {}, roles: {}, members: { u1: member }, emojis: [], stickers: [], memberCount: 1 } },
    guildOrder: ['g1'],
  });
});

afterEach(cleanup);

describe('ServerProfiles', () => {
  it('lists servers, prefills the current nickname and falls back to the global bio in the preview', () => {
    render(<ServerProfiles />);
    expect(screen.getByTestId('server-profile-guild')).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Test Server' })).toBeTruthy();
    expect((screen.getByLabelText(/Server Nickname/) as HTMLInputElement).value).toBe('Old Nick');
    // member bio is unset, so the preview shows the user-level About Me
    expect(screen.getByTestId('md').textContent).toBe('global bio');
  });

  it('saves only the changed field and applies the updated member', async () => {
    const updated = { ...member, bio: 'New <bio>' };
    patchMember.mockResolvedValue(updated as never);
    render(<ServerProfiles />);
    fireEvent.change(screen.getByLabelText(/About Me/), { target: { value: 'New <bio>' } });
    fireEvent.click(screen.getByText('Save Changes'));
    await waitFor(() => expect(patchMember).toHaveBeenCalledWith('g1', '@me', { bio: 'New <bio>' }));
    await waitFor(() => expect(useData.getState().guilds.g1!.members.u1!.bio).toBe('New <bio>'));
    // the preview now reflects the per-server override
    await waitFor(() => expect(screen.getByTestId('md').textContent).toBe('New <bio>'));
  });

  it('Choose GIF stages an animated server avatar and banner and saves them', async () => {
    vi.mocked(api.files.uploadImageFromUrl).mockImplementation((async (kind: string) => `/api/v1/files/k/${kind}.gif`) as never);
    patchMember.mockResolvedValue(member as never);
    render(<ServerProfiles />);
    const buttons = screen.getAllByText('Choose GIF');
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]!); (useUI.getState().modal as any).onPick('https://media.example/a.gif');
    await waitFor(() => expect(api.files.uploadImageFromUrl).toHaveBeenCalledWith('avatar', 'https://media.example/a.gif'));
    fireEvent.click(screen.getAllByText('Choose GIF')[1]!); (useUI.getState().modal as any).onPick('https://media.example/b.gif');
    await waitFor(() => expect(api.files.uploadImageFromUrl).toHaveBeenCalledWith('banner', 'https://media.example/b.gif'));
    fireEvent.click(await screen.findByText('Save Changes'));
    await waitFor(() => expect(patchMember).toHaveBeenCalledWith('g1', '@me', { avatar: '/api/v1/files/k/avatar.gif', banner: '/api/v1/files/k/banner.gif' }));
  });

  it('saves nickname and pronouns, and Remove banner clears an existing banner', async () => {
    useData.setState((s) => ({ guilds: { g1: { ...s.guilds.g1!, members: { u1: { ...member, banner: '/api/v1/files/k/b.gif' } } } } }) as never);
    patchMember.mockResolvedValue(member as never);
    render(<ServerProfiles />);
    fireEvent.change(screen.getByLabelText(/Server Nickname/), { target: { value: 'Neo' } });
    fireEvent.change(screen.getByLabelText('Pronouns'), { target: { value: 'he/him' } });
    fireEvent.click(screen.getByText('Remove banner'));
    fireEvent.click(screen.getByText('Save Changes'));
    await waitFor(() => expect(patchMember).toHaveBeenCalledWith('g1', '@me', { nick: 'Neo', pronouns: 'he/him', banner: null }));
  });
});
