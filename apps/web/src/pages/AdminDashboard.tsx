/** Instance super admin dashboard at /admin: stats, every user and server, read-only message viewer, reports, account disable. */
import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Ban, CheckCircle2, Flag, Hash, LayoutDashboard, LogIn, ScrollText, Server, ShieldAlert, Users, Zap } from 'lucide-react';
import { api } from '@/lib/api';
import { toast, toastError } from '@/stores/ui';
import { USER_BADGES, UserFlags, hasUserFlag } from '@jorcord/shared';

type Tab = 'overview' | 'users' | 'servers' | 'reports' | 'audit';
const fmt = (d?: string | null) => (d ? new Date(d).toLocaleString() : '—');
const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export function AdminDashboard() {
  const me = useQuery({ queryKey: ['admin', 'me'], queryFn: api.admin.me, retry: false });
  const [tab, setTab] = useState<Tab>('overview');
  if (me.isLoading) return <div className="p-8 text-muted">Loading…</div>;
  if (!me.data?.admin) return <Navigate to="/channels/@me" replace />;
  const tabs: { id: Tab; label: string; icon: typeof Users }[] = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard }, { id: 'users', label: 'Users', icon: Users },
    { id: 'servers', label: 'Servers', icon: Server }, { id: 'reports', label: 'Reports', icon: Flag }, { id: 'audit', label: 'Admin log', icon: ScrollText },
  ];
  return (
    <div className="flex h-full min-h-0 bg-chat text-normal" data-testid="admin-dashboard">
      <nav className="flex w-56 shrink-0 flex-col gap-1 bg-side p-3">
        <Link to="/channels/@me" className="mb-3 flex items-center gap-2 text-sm text-muted hover:text-normal"><ArrowLeft size={16} /> Back to Jorcord</Link>
        <div className="mb-2 flex items-center gap-2 px-2 font-semibold"><ShieldAlert size={18} /> Admin</div>
        {tabs.map((t) => (
          <button key={t.id} type="button" onClick={() => setTab(t.id)}
            className={cx('flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm', tab === t.id ? 'bg-active text-normal' : 'text-muted hover:bg-hover')}>
            <t.icon size={16} /> {t.label}
          </button>
        ))}
      </nav>
      <main className="min-w-0 flex-1 overflow-y-auto p-6">
        {!me.data.mfaEnabled && (
          <div role="alert" className="mb-5 rounded-lg border border-warn/60 bg-warn/10 p-4 text-sm">
            This account can see everything. Turn on two-factor authentication in User Settings → My Account to protect it.
          </div>
        )}
        <GodMode until={me.data.godModeUntil} mfa={me.data.mfaEnabled} />
        {tab === 'overview' && <Overview />}
        {tab === 'users' && <UsersTab />}
        {tab === 'servers' && <ServersTab />}
        {tab === 'reports' && <ReportsTab />}
        {tab === 'audit' && <AuditTab />}
      </main>
    </div>
  );
}

function Overview() {
  const { data } = useQuery({ queryKey: ['admin', 'stats'], queryFn: api.admin.stats, refetchInterval: 30_000 });
  const cards: [string, string][] = [['users', 'Users'], ['newUsers24h', 'New users (24h)'], ['activeSessions', 'Active sessions'], ['guilds', 'Servers'],
    ['channels', 'Channels'], ['messages', 'Messages'], ['bots', 'Bots'], ['disabled', 'Disabled accounts'], ['reports', 'Reports']];
  return (
    <section>
      <h1 className="mb-4 text-xl font-semibold">Overview</h1>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-3">
        {cards.map(([k, label]) => (
          <div key={k} className="rounded-lg bg-side p-4">
            <div className="text-xs uppercase text-muted">{label}</div>
            <div className="mt-1 text-2xl font-semibold" data-testid={`stat-${k}`}>{data?.[k] ?? '…'}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Search({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return <input aria-label={placeholder} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} className="mb-4 w-full max-w-md rounded bg-input px-3 py-2 text-sm" />;
}

function UsersTab() {
  const [q, setQ] = useState(''); const [sel, setSel] = useState<string | null>(null);
  const { data = [] } = useQuery({ queryKey: ['admin', 'users', q], queryFn: () => api.admin.users(q) });
  if (sel) return <UserDetail id={sel} onBack={() => setSel(null)} />;
  return (
    <section>
      <h1 className="mb-4 text-xl font-semibold">Users</h1>
      <Search value={q} onChange={setQ} placeholder="Search username, email or ID" />
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase text-muted"><tr><th className="py-2">User</th><th>Email</th><th>Servers</th><th>Joined</th><th>Last seen</th><th>Status</th></tr></thead>
        <tbody>
          {data.map((u: any) => (
            <tr key={u.id} className="cursor-pointer border-t border-divider hover:bg-hover" onClick={() => setSel(u.id)}>
              <td className="py-2">{u.displayName || u.username} <span className="text-muted">@{u.username}</span>{u.bot && <span className="ml-1 rounded bg-brand px-1 text-xs text-white">BOT</span>}</td>
              <td>{u.email ?? '—'}</td><td>{u.guilds}</td><td>{fmt(u.createdAt)}</td><td>{fmt(u.lastSeen)}</td>
              <td>{u.disabledAt ? <span className="text-danger">Disabled</span> : u.deletedAt ? <span className="text-muted">Deleted</span> : 'Active'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function UserDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const qc = useQueryClient();
  const { data: u } = useQuery({ queryKey: ['admin', 'user', id], queryFn: () => api.admin.user(id) });
  const toggle = async () => {
    if (!u) return;
    if (!u.disabledAt && !window.confirm(`Disable @${u.username}? They are logged out everywhere and cannot log in until re-enabled.`)) return;
    try {
      await (u.disabledAt ? api.admin.enable(id) : api.admin.disable(id));
      toast(u.disabledAt ? 'Account enabled' : 'Account disabled');
      await qc.invalidateQueries({ queryKey: ['admin'] });
    } catch (e) { toastError(e); }
  };
  if (!u) return <div className="text-muted">Loading…</div>;
  return (
    <section>
      <button type="button" onClick={onBack} className="mb-4 flex items-center gap-1 text-sm text-muted hover:text-normal"><ArrowLeft size={14} /> All users</button>
      <h1 className="text-xl font-semibold">{u.displayName || u.username} <span className="text-muted">@{u.username}</span></h1>
      <p className="mb-4 text-sm text-muted">ID {u.id} · {u.email ?? 'no email'} · joined {fmt(u.createdAt)} · 2FA {u.mfaEnabled ? 'on' : 'off'} · {u.verified ? 'verified' : 'unverified'}</p>
      <button type="button" onClick={() => void toggle()} className={cx('btn mb-6 flex items-center gap-2', u.disabledAt ? 'btn-primary' : 'btn-danger')}>
        {u.disabledAt ? <><CheckCircle2 size={16} /> Enable account</> : <><Ban size={16} /> Disable account</>}
      </button>
      <h2 className="mb-2 font-semibold">Badges</h2>
      <div className="mb-6 flex flex-wrap gap-x-4 gap-y-1 text-sm" role="group" aria-label="Badges">
        {USER_BADGES.map((b) => (
          <label key={b.flag} className="flex items-center gap-1.5"><input type="checkbox" checked={hasUserFlag(u.publicFlags, b.flag)} onChange={(e) => {
            const next = e.target.checked ? (u.publicFlags | UserFlags[b.flag]) : (u.publicFlags & ~UserFlags[b.flag]);
            api.admin.setFlags(id, next).then(() => qc.invalidateQueries({ queryKey: ['admin', 'user', id] })).catch(toastError);
          }} />{b.label}</label>
        ))}
      </div>
      <h2 className="mb-2 font-semibold">Servers ({u.guilds.length})</h2>
      <ul className="mb-6 text-sm">{u.guilds.map((g: any) => <li key={g.id}>{g.name}{g.owner && <span className="ml-1 text-muted">(owner)</span>} <span className="text-muted">· joined {fmt(g.joinedAt)}</span></li>)}</ul>
      <h2 className="mb-2 font-semibold">Active sessions ({u.sessions.length})</h2>
      <ul className="text-sm">{u.sessions.map((s: any) => <li key={s.id} className="truncate">{s.ip} · {s.userAgent || 'unknown client'} <span className="text-muted">· last used {fmt(s.lastUsedAt)}</span></li>)}</ul>
    </section>
  );
}

function ServersTab() {
  const [q, setQ] = useState(''); const [sel, setSel] = useState<string | null>(null);
  const { data = [] } = useQuery({ queryKey: ['admin', 'guilds', q], queryFn: () => api.admin.guilds(q) });
  if (sel) return <ServerDetail id={sel} onBack={() => setSel(null)} />;
  return (
    <section>
      <h1 className="mb-4 text-xl font-semibold">Servers</h1>
      <Search value={q} onChange={setQ} placeholder="Search server name or ID" />
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase text-muted"><tr><th className="py-2">Server</th><th>Owner</th><th>Members</th><th>Channels</th><th>Created</th></tr></thead>
        <tbody>
          {data.map((g: any) => (
            <tr key={g.id} className="cursor-pointer border-t border-divider hover:bg-hover" onClick={() => setSel(g.id)}>
              <td className="py-2">{g.name}</td><td>@{g.ownerName ?? '?'}</td><td>{g.members}</td><td>{g.channels}</td><td>{fmt(g.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ServerDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { data: g } = useQuery({ queryKey: ['admin', 'guild', id], queryFn: () => api.admin.guild(id) });
  const [channel, setChannel] = useState<string | null>(null);
  if (!g) return <div className="text-muted">Loading…</div>;
  const text = g.channels.filter((c: any) => c.type !== 'category');
  return (
    <section>
      <button type="button" onClick={onBack} className="mb-4 flex items-center gap-1 text-sm text-muted hover:text-normal"><ArrowLeft size={14} /> All servers</button>
      <h1 className="text-xl font-semibold">{g.name}</h1>
      <p className="mb-4 text-sm text-muted">ID {g.id} · owner @{g.ownerName} · created {fmt(g.createdAt)} · {g.members.length} members</p>
      <JoinButton guildId={g.id} firstChannel={text[0]?.id} />
      <div className="flex min-h-0 gap-4">
        <div className="w-56 shrink-0">
          <h2 className="mb-2 font-semibold">Channels</h2>
          {text.map((c: any) => (
            <button key={c.id} type="button" onClick={() => setChannel(c.id)}
              className={cx('flex w-full items-center gap-1 rounded px-2 py-1 text-left text-sm', channel === c.id ? 'bg-active' : 'text-muted hover:bg-hover')}>
              <Hash size={14} /> {c.name} <span className="ml-auto text-xs">{c.type}</span>
            </button>
          ))}
          <h2 className="mb-2 mt-4 font-semibold">Members</h2>
          <ul className="text-sm text-muted">{g.members.map((m: any) => <li key={m.id}>@{m.username}{m.nick && ` (${m.nick})`}</li>)}</ul>
        </div>
        <div className="min-w-0 flex-1">{channel ? <Messages channelId={channel} /> : <p className="text-muted">Select a channel to read its messages.</p>}</div>
      </div>
    </section>
  );
}

function Messages({ channelId }: { channelId: string }) {
  const [pages, setPages] = useState<any[][]>([]);
  const first = useQuery({ queryKey: ['admin', 'messages', channelId], queryFn: () => api.admin.messages(channelId) });
  const all = [...(first.data ?? []), ...pages.flat()];
  const more = async () => { const last = all[all.length - 1]; if (last) setPages([...pages, await api.admin.messages(channelId, last.id)]); };
  return (
    <div>
      <h2 className="mb-2 font-semibold">Messages (newest first, read-only)</h2>
      {all.length === 0 && <p className="text-muted">No messages.</p>}
      <ul className="space-y-2 text-sm">
        {all.map((m: any) => (
          <li key={m.id} className="rounded bg-side p-2">
            <div className="text-xs text-muted">@{m.authorName ?? m.authorId} · {fmt(m.createdAt)}{m.editedAt && ' · edited'}{m.attachments > 0 && ` · ${m.attachments} attachment(s)`}</div>
            <div className="whitespace-pre-wrap break-words">{m.content || <span className="text-muted">(no text)</span>}</div>
          </li>
        ))}
      </ul>
      {all.length >= 50 && <button type="button" className="btn mt-3" onClick={() => void more()}>Load older</button>}
    </div>
  );
}

function ReportsTab() {
  const { data = [] } = useQuery({ queryKey: ['admin', 'reports'], queryFn: api.admin.reports });
  return (
    <section>
      <h1 className="mb-4 text-xl font-semibold">Reports</h1>
      {data.length === 0 && <p className="text-muted">No reports.</p>}
      <ul className="space-y-2 text-sm">{data.map((r: any) => <li key={r.id} className="rounded bg-side p-3"><pre className="whitespace-pre-wrap break-words text-xs">{JSON.stringify(r, null, 2)}</pre></li>)}</ul>
    </section>
  );
}

function useGodActive() {
  const { data } = useQuery({ queryKey: ['admin', 'me'], queryFn: api.admin.me, retry: false });
  const until = data?.godModeUntil ? Date.parse(data.godModeUntil) : 0;
  return until > Date.now() ? until : 0;
}

/** God mode banner: off → re-authenticate to turn on (60 min); on → countdown and turn off. */
function GodMode({ until, mfa }: { until: string | null; mfa: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false); const [password, setPassword] = useState(''); const [totp, setTotp] = useState('');
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const left = Math.max(0, (until ? Date.parse(until) : 0) - now); const on = left > 0;
  useEffect(() => { if (until && !on) void qc.invalidateQueries({ queryKey: ['admin', 'me'] }); }, [on, until, qc]);
  const toggle = async (enabled: boolean) => {
    try {
      await api.admin.godMode(enabled ? { enabled, password, ...(mfa ? { totp } : {}) } : { enabled });
      setOpen(false); setPassword(''); setTotp('');
      toast(enabled ? 'God mode on for 60 minutes. Every change you make is logged.' : 'God mode off');
      await qc.invalidateQueries({ queryKey: ['admin'] });
    } catch (e) { toastError(e); }
  };
  if (on) {
    const m = Math.floor(left / 60_000), sec = Math.floor((left % 60_000) / 1000);
    return (
      <div role="status" className="mb-5 flex items-center gap-3 rounded-lg border border-danger/60 bg-danger/10 p-4 text-sm" data-testid="god-mode-on">
        <Zap size={18} className="text-danger" />
        <div className="flex-1"><b>God mode is ON</b>: you have owner-level control in every server. Every change is logged. Turns off in {m}:{String(sec).padStart(2, '0')}.</div>
        <button type="button" className="btn btn-danger" onClick={() => void toggle(false)}>Turn off</button>
      </div>
    );
  }
  return (
    <div className="mb-5 rounded-lg bg-side p-4 text-sm">
      <div className="flex items-center gap-3">
        <Zap size={18} className="text-muted" />
        <div className="flex-1"><b>God mode is off.</b> Turn it on to act as owner in every server: bypass permissions, read any channel, delete messages, remove members, join any server. Lasts 60 minutes.</div>
        {!open && <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>Turn on…</button>}
      </div>
      {open && (
        <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void toggle(true); }}>
          <label className="flex flex-col gap-1"><span className="label">Confirm password</span>
            <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="rounded bg-input px-3 py-2" /></label>
          {mfa && <label className="flex flex-col gap-1"><span className="label">2FA code</span>
            <input inputMode="numeric" autoComplete="one-time-code" required value={totp} onChange={(e) => setTotp(e.target.value)} className="w-32 rounded bg-input px-3 py-2" /></label>}
          <button type="submit" className="btn btn-danger">Turn on god mode</button>
          <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
        </form>
      )}
    </div>
  );
}

function JoinButton({ guildId, firstChannel }: { guildId: string; firstChannel?: string }) {
  const god = useGodActive(); const navigate = useNavigate();
  const join = async () => {
    try { await api.admin.joinGuild(guildId); navigate(`/channels/${guildId}${firstChannel ? `/${firstChannel}` : ''}`); } catch (e) { toastError(e); }
  };
  return (
    <button type="button" disabled={!god} title={god ? undefined : 'Turn on god mode first'} onClick={() => void join()} className="btn btn-primary mb-5 flex items-center gap-2">
      <LogIn size={16} /> Join and open in Jorcord
    </button>
  );
}

function AuditTab() {
  const { data = [] } = useQuery({ queryKey: ['admin', 'audit'], queryFn: api.admin.audit, refetchInterval: 15_000 });
  return (
    <section>
      <h1 className="mb-1 text-xl font-semibold">Admin log</h1>
      <p className="mb-4 text-sm text-muted">Every change made while god mode was on, plus each time it was turned on or off.</p>
      {data.length === 0 && <p className="text-muted">Nothing logged yet.</p>}
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase text-muted"><tr><th className="py-2">When</th><th>Action</th><th>Path</th><th>Result</th></tr></thead>
        <tbody>{data.map((e: any) => (
          <tr key={e.id} className="border-t border-divider"><td className="py-1.5">{fmt(e.createdAt)}</td><td>{e.action}</td><td className="font-mono text-xs">{e.path}</td><td>{e.status ?? '—'}</td></tr>
        ))}</tbody>
      </table>
    </section>
  );
}
