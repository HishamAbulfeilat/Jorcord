import { useMemo, useState } from 'react';
import { Check, Menu, MessageSquare, MoreVertical, Search, UserPlus, Users, X, Inbox } from 'lucide-react';
import type { Relationship } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { useUI, toast, toastError } from '@/stores/ui';
import { Avatar, PRESENCE_LABEL } from '@/components/ui/Avatar';
import { Empty, Tabs } from '@/components/ui/primitives';
import { cx, displayName } from '@/lib/format';
import { openDmWith, userMenu } from '@/lib/menus';
import { useIsMobile } from '@/lib/hooks';
import { useMenuTrigger } from '@/components/ui/ContextMenu';
import { Logo } from '@/components/ui/Logo';
import { t } from '@/i18n';

type Tab = 'online' | 'all' | 'pending' | 'blocked' | 'add';

function FriendRow({ r }: { r: Relationship }) {
  const open = useUI((s) => s.openPopout); const openMenu = useUI((s) => s.openMenu);
  const presence = useData((s) => s.presences[r.user.id]); const u = useData((s) => s.users[r.user.id]) ?? r.user;
  const trig = useMenuTrigger(() => userMenu(r.user.id));
  const act = (p: Promise<unknown>, ok?: string) => p.then(() => ok && toast(ok, 'success')).catch(toastError);
  const IconBtn = ({ label, onClick, children, danger }: { label: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; children: React.ReactNode; danger?: boolean }) => <button aria-label={label} title={label} onClick={onClick} className={cx('flex h-9 w-9 items-center justify-center rounded-full bg-side text-interactive hover:text-header group-hover/f:bg-rail', danger ? 'hover:text-danger' : '')}>{children}</button>;
  return (
    <li className="group/f flex items-center gap-3 border-t border-divider/60 px-2 py-2.5 hover:rounded-lg hover:bg-hover" {...trig}>
      <button onClick={(e) => open({ kind: 'user', userId: r.user.id, rect: e.currentTarget.getBoundingClientRect() })} className="flex min-w-0 flex-1 items-center gap-3 text-start">
        <Avatar user={u} size={32} presence ring="rgb(var(--chat))" />
        <span className="min-w-0 leading-tight"><span className="block truncate font-semibold text-header">{displayName(u)} <span className="hidden text-sm font-normal text-muted group-hover/f:inline">{u.username}</span></span>
          <span className="block truncate text-sm text-muted">{r.type === 'incoming' ? 'Incoming Friend Request' : r.type === 'outgoing' ? 'Outgoing Friend Request' : r.type === 'blocked' ? 'Blocked' : u.customStatus?.text || PRESENCE_LABEL[presence ?? 'offline']}</span></span>
      </button>
      <div className="flex gap-2">
        {r.type === 'friend' && <><IconBtn label={t('Message')} onClick={() => openDmWith(r.user.id)}><MessageSquare size={18} /></IconBtn><IconBtn label={t('More')} onClick={(e) => { const b = e.currentTarget.getBoundingClientRect(); openMenu(b.left - 180, b.bottom, userMenu(r.user.id)); }}><MoreVertical size={18} /></IconBtn></>}
        {r.type === 'incoming' && <><IconBtn label={t('Accept')} onClick={() => act(api.users.setRelationship(r.user.id, 'friend'))}><Check size={18} className="text-success" /></IconBtn><IconBtn danger label={t('Ignore')} onClick={() => act(api.users.removeRelationship(r.user.id).then(() => useData.getState().apply('RELATIONSHIP_REMOVE', { userId: r.user.id })))}><X size={18} /></IconBtn></>}
        {r.type === 'outgoing' && <IconBtn danger label={t('Cancel')} onClick={() => act(api.users.removeRelationship(r.user.id).then(() => useData.getState().apply('RELATIONSHIP_REMOVE', { userId: r.user.id })))}><X size={18} /></IconBtn>}
        {r.type === 'blocked' && <button className="btn btn-secondary" onClick={() => act(api.users.removeRelationship(r.user.id).then(() => useData.getState().apply('RELATIONSHIP_REMOVE', { userId: r.user.id })), 'Unblocked')}>{t('Unblock')}</button>}
      </div>
    </li>
  );
}

function AddFriend() {
  const [name, setName] = useState(''); const [state, setState] = useState<{ ok: boolean; msg: string } | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); if (!name.trim()) return; setBusy(true); setState(null);
    try {
      const uname = name.trim().replace(/^@/, ''); const found = await api.users.findByUsername(uname).catch(() => []);
      const target = found.find((u) => u.username.toLowerCase() === uname.toLowerCase()) ?? (/^\d{5,}$/.test(uname) ? { id: uname, username: uname } : undefined);
      if (!target) throw new Error(`Hm, didn't work. Double check that the username is correct.`);
      await api.users.setRelationship(target.id, 'friend'); setState({ ok: true, msg: `Success! Your friend request to ${target.username} was sent.` }); setName('');
    } catch (err) { setState({ ok: false, msg: (err as Error).message }); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="p-6 md:px-8">
      <h2 className="text-base font-bold text-header">{t('Add Friend')}</h2><p className="mb-4 text-sm text-muted">{t('You can add friends with their Jorcord username.')}</p>
      <div className={cx('flex items-center gap-2 rounded-lg border bg-rail px-3 py-1.5', state && (state.ok ? 'border-success' : 'border-danger'))}>
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label={t('Username')} placeholder={t('You can add friends with their username.')} className="h-10 min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted" />
        <button type="submit" disabled={!name.trim() || busy} className="btn btn-primary btn-lg whitespace-nowrap">{t('Send Friend Request')}</button>
      </div>
      {state && <p role="status" className={cx('mt-2 text-sm', state.ok ? 'text-success' : 'text-danger')}>{state.msg}</p>}
    </form>
  );
}

export function FriendsHome() {
  const rels = useData((s) => s.relationships); const presences = useData((s) => s.presences); const mobile = useIsMobile();
  const [tab, setTab] = useState<Tab>('online'); const [q, setQ] = useState(''); const setLeft = useUI((s) => s.setLeftDrawer); const open = useUI((s) => s.openModal);
  const all = Object.values(rels);
  const list = useMemo(() => {
    const f = (r: Relationship) => !q || r.user.username.toLowerCase().includes(q.toLowerCase()) || (r.user.displayName ?? '').toLowerCase().includes(q.toLowerCase());
    const byName = (a: Relationship, b: Relationship) => displayName(a.user).localeCompare(displayName(b.user));
    if (tab === 'online') return all.filter((r) => r.type === 'friend' && presences[r.user.id] && presences[r.user.id] !== 'offline' && presences[r.user.id] !== 'invisible').filter(f).sort(byName);
    if (tab === 'all') return all.filter((r) => r.type === 'friend').filter(f).sort(byName);
    if (tab === 'pending') return all.filter((r) => r.type === 'incoming' || r.type === 'outgoing').filter(f);
    if (tab === 'blocked') return all.filter((r) => r.type === 'blocked').filter(f).sort(byName);
    return [];
  }, [all.length, rels, presences, tab, q]); // eslint-disable-line
  const pending = all.filter((r) => r.type === 'incoming').length;
  const label = { online: 'Online', all: 'All Friends', pending: 'Pending', blocked: 'Blocked', add: '' }[tab];
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-chat">
      <header className="flex h-12 shrink-0 items-center gap-2 px-2 shadow-[0_1px_0_rgb(0_0_0/0.2)] safe-top box-content md:gap-4 md:px-4">
        {mobile && <button aria-label={t('Open navigation')} onClick={() => setLeft(true)} className="flex h-11 w-11 items-center justify-center text-interactive"><Menu size={24} /></button>}
        <div className="flex items-center gap-2 font-semibold text-header"><Users size={24} className="text-muted" /><span>{t('Friends')}</span></div>
        <span className="hidden h-6 w-px bg-divider md:block" />
        <div className="min-w-0 flex-1 overflow-x-auto scroller-hide">
          <Tabs label={t('Friends')} value={tab} onChange={setTab} tabs={[{ id: 'online', label: 'Online' }, { id: 'all', label: 'All' }, { id: 'pending', label: 'Pending', badge: pending }, { id: 'blocked', label: 'Blocked' }, { id: 'add', label: 'Add Friend' }]} />
        </div>
        <button aria-label={t('New group DM')} onClick={() => open({ kind: 'newDm' })} className="hidden h-8 w-8 items-center justify-center text-interactive hover:text-header md:flex"><MessageSquare size={22} /></button>
        <button aria-label={t('Inbox')} onClick={() => open({ kind: 'inbox' })} className="flex h-9 w-9 items-center justify-center text-interactive hover:text-header md:h-8 md:w-8"><Inbox size={22} /></button>
      </header>
      {tab === 'add' ? <div className="scroller min-h-0 flex-1"><AddFriend /></div> : (
        <div className="scroller min-h-0 flex-1 p-4 md:px-8 md:py-4">
          <div className="mb-4 flex items-center rounded bg-rail px-2"><input value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('Search friends')} placeholder={t('Search')} className="h-9 flex-1 bg-transparent outline-none placeholder:text-muted" /><Search size={16} className="text-muted" /></div>
          {list.length > 0 && <h2 className="section-title mb-2">{label} — {list.length}</h2>}
          <ul>{list.map((r) => <FriendRow key={r.user.id} r={r} />)}</ul>
          {!list.length && (
            <Empty icon={<Logo size={72} />} title={tab === 'online' ? 'No one’s around to play with Jorcord.' : tab === 'pending' ? 'There are no pending friend requests.' : tab === 'blocked' ? 'You can’t unblock the Wumpus.' : 'You have no friends yet.'}>
              {tab !== 'blocked' && <button className="btn btn-primary mt-3" onClick={() => setTab('add')}><UserPlus size={16} />{t('Add Friend')}</button>}
            </Empty>
          )}
        </div>
      )}
    </div>
  );
}
