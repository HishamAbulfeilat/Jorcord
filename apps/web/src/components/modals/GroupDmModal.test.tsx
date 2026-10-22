import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useData } from '@/stores/data';

vi.mock('@/lib/api', () => ({ api: { channels: { patch: vi.fn() } } }));
vi.mock('./ModalHost', () => ({ IconPicker: () => null }));
import { api } from '@/lib/api';
import { GroupDmModal } from './GroupDmModal';

const user = (id: string) => ({ id, username: id, displayName: id.toUpperCase(), avatar: null, banner: null, accentColor: null, bio: null, pronouns: null, bot: false, createdAt: '' });
const group = (ownerId: string) => ({ id: 'g1', guildId: null, type: 'group_dm', name: 'Squad', icon: null, ownerId, recipients: [user('bob'), user('cat')], topic: null, position: 0, parentId: null, nsfw: false, slowmode: 0, bitrate: null, userLimit: null, overwrites: [], lastMessageId: null, createdAt: '' });
const patch = vi.mocked(api.channels.patch);
beforeEach(() => { patch.mockReset(); patch.mockImplementation(async (_id, b) => ({ ...group('me'), ...b }) as never); });
afterEach(cleanup);

const setup = (ownerId: string) => { useData.setState({ me: user('me'), dms: { g1: group(ownerId) } } as never); return render(<GroupDmModal channelId="g1" close={vi.fn()} />); };

describe('GroupDmModal', () => {
  it('saves the name', async () => {
    setup('me');
    fireEvent.change(screen.getByLabelText('Group name'), { target: { value: ' New name ' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('g1', { name: 'New name', icon: null }));
  });
  it('lets the owner hand over ownership', async () => {
    setup('me');
    fireEvent.click(screen.getByLabelText('Make BOB owner'));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('g1', { ownerId: 'bob' }));
  });
  it('hides the transfer list from non-owners', () => {
    setup('bob');
    expect(screen.queryByText('Transfer ownership')).toBeNull();
  });
});
