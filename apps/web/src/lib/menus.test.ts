import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_EVERYONE, Perm } from '@jorcord/shared';
import { useData } from '@/stores/data';
import { guildMenu } from './menus';

const user = (id: string): any => ({ id, username: id, displayName: id, avatar: null, banner: null, bio: null, pronouns: null, bot: false });
function setup(myRoles: { id: string; permissions: string }[], owner = 'someone') {
  const roles: any = { g1: { id: 'g1', guildId: 'g1', name: '@everyone', permissions: DEFAULT_EVERYONE.toString(), position: 0 } };
  for (const r of myRoles) roles[r.id] = { ...r, guildId: 'g1', name: r.id, position: 1 };
  useData.setState({
    ready: true, me: user('me'),
    guilds: { g1: { guild: { id: 'g1', name: 'G', ownerId: owner, features: [], rulesChannelId: null, description: null } as any, channels: {}, roles, members: { me: { guildId: 'g1', user: user('me'), nick: null, roles: myRoles.map((r) => r.id), joinedAt: '', timeoutUntil: null } as any }, emojis: [], stickers: [], memberCount: 1 } },
    guildOrder: ['g1'],
  } as never);
}
afterEach(() => useData.setState({ guilds: {}, guildOrder: [] } as never));

describe('server dropdown', () => {
  const labels = () => guildMenu('g1').map((i) => ('label' in i ? i.label : undefined));

  it('offers "Add App" to members who can manage the server, and not to others', () => {
    setup([]);
    expect(labels()).not.toContain('Add App');
    setup([{ id: 'mgr', permissions: Perm.MANAGE_GUILD.toString() }]);
    expect(labels()).toContain('Add App');
    setup([], 'me'); // the owner
    expect(labels()).toContain('Add App');
  });

  it('"Add App" opens the App Directory for this server', () => {
    setup([{ id: 'mgr', permissions: Perm.MANAGE_GUILD.toString() }]);
    const item = guildMenu('g1').find((i) => 'label' in i && i.label === 'Add App') as { onClick: () => void };
    const seen: string[] = []; const h = (e: Event) => seen.push((e as CustomEvent).detail.to); window.addEventListener('jorcord:navigate', h);
    item.onClick();
    window.removeEventListener('jorcord:navigate', h);
    expect(seen).toEqual(['/discover?tab=apps&guild=g1']);
  });
});
