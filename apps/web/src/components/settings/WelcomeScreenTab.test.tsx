import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Perm } from '@jorcord/shared';

vi.mock('@/lib/api', () => ({ api: { guilds: { patchWelcomeScreen: vi.fn() } } }));

import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { WelcomeScreenTab } from './WelcomeScreenTab';

const patch = vi.mocked(api.guilds.patchWelcomeScreen);
const ch = (id: string, name: string, position: number, overwrites: unknown[] = []) => ({ id, guildId: 'g1', type: 'text', name, topic: null, position, parentId: null, nsfw: false, slowmode: 0, overwrites, lastMessageId: null });

beforeEach(() => {
  patch.mockReset();
  useData.setState({
    guilds: {
      g1: {
        guild: { id: 'g1', name: 'Hub', features: ['COMMUNITY'], welcomeScreen: { enabled: true, description: 'Hi', channels: [{ channelId: 'c1', description: 'Rules', emoji: null }] } },
        // c3 is hidden from @everyone by an overwrite and must not be offered
        channels: { c1: ch('c1', 'rules', 0), c2: ch('c2', 'general', 1), c3: ch('c3', 'staff', 2, [{ id: 'g1', type: 'role', allow: '0', deny: String(Perm.VIEW_CHANNEL) }]) },
        roles: { g1: { id: 'g1', guildId: 'g1', name: '@everyone', color: 0, hoist: false, position: 0, permissions: String(Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES), mentionable: false, icon: null } },
        members: {}, emojis: [], stickers: [], memberCount: 1,
      },
    },
  } as never);
});
afterEach(cleanup);

describe('WelcomeScreenTab', () => {
  it('offers only channels everyone can see and saves the edited screen', async () => {
    patch.mockResolvedValue({ enabled: true, description: 'Hi', channels: [] });
    render(<WelcomeScreenTab guildId="g1" />);
    const add = screen.getByLabelText('Add a channel') as HTMLSelectElement;
    const options = [...add.options].map((o) => o.textContent);
    expect(options).toContain('#general'); expect(options).not.toContain('#staff'); expect(options).not.toContain('#rules'); // rules is already listed
    fireEvent.change(add, { target: { value: 'c2' } });
    // the new row has no description yet: saving is not possible until it has one
    fireEvent.change(screen.getByLabelText('Description for general'), { target: { value: 'Say hi' } });
    fireEvent.click(await screen.findByRole('button', { name: /save/i }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('g1', { enabled: true, description: 'Hi', channels: [{ channelId: 'c1', description: 'Rules', emoji: null }, { channelId: 'c2', description: 'Say hi', emoji: null }] }));
  });
});
