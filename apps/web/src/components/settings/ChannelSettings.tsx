import { useEffect, useMemo, useState } from 'react';
import { Hash, Lock, Plus, Trash2, Settings as Cog, Shield, User as UserIcon } from 'lucide-react';
import type { Channel, OverwriteDTO } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { useUI, toast, toastError } from '@/stores/ui';
import { H1, H3, SaveBar, SettingsLayout } from './SettingsLayout';
import { OverwriteGrid } from './PermGrid';
import { Field, Toggle } from '@/components/ui/primitives';
import { intToHex } from '@/lib/perms';
import { cx, displayName } from '@/lib/format';

const SLOWMODES = [[0, 'Off'], [5, '5s'], [10, '10s'], [15, '15s'], [30, '30s'], [60, '1m'], [120, '2m'], [300, '5m'], [600, '10m'], [900, '15m'], [1800, '30m'], [3600, '1h'], [7200, '2h'], [21600, '6h']] as const;

export function ChannelSettings({ channelId, close }: { channelId: string; close: () => void }) {
  const ch = useData((s) => Object.values(s.guilds).map((g) => g.channels[channelId]).find(Boolean)) as Channel | undefined;
  const g = useData((s) => (ch?.guildId ? s.guilds[ch.guildId] : undefined));
  const [tab, setTab] = useState('overview');
  const [f, setF] = useState({ name: ch?.name ?? '', topic: ch?.topic ?? '', nsfw: ch?.nsfw ?? false, slowmode: ch?.slowmode ?? 0, bitrate: ch?.bitrate ?? 64000, userLimit: ch?.userLimit ?? 0 });
  const [ows, setOws] = useState<OverwriteDTO[]>(ch?.overwrites ?? []); const [sel, setSel] = useState<string | null>(ch?.overwrites?.[0]?.id ?? g?.guild.id ?? null);
  const [busy, setBusy] = useState(false); const openModal = useUI((s) => s.openModal);
  useEffect(() => { if (ch) { setOws(ch.overwrites ?? []); } }, [ch?.overwrites]); // eslint-disable-line
  const dirtyOverview = !!ch && (f.name !== (ch.name ?? '') || f.topic !== (ch.topic ?? '') || f.nsfw !== ch.nsfw || f.slowmode !== ch.slowmode || (ch.type === 'voice' && (f.bitrate !== (ch.bitrate ?? 64000) || f.userLimit !== (ch.userLimit ?? 0))));
  const dirtyOws = JSON.stringify(ows) !== JSON.stringify(ch?.overwrites ?? []);
  const label = useMemo(() => (ow: OverwriteDTO) => ow.type === 'role' ? (g?.roles[ow.id]?.name ?? 'role') : displayName(g?.members[ow.id]?.user ?? { username: 'member', displayName: null }, g?.members[ow.id]), [g]);
  if (!ch || !g) return null;
  const saveOverview = async () => {
    setBusy(true);
    try { const u = await api.channels.patch(ch.id, { name: ch.type === 'category' ? f.name : f.name.toLowerCase().replace(/\s+/g, '-'), topic: f.topic || null, nsfw: f.nsfw, slowmode: f.slowmode, ...(ch.type === 'voice' ? { bitrate: f.bitrate, userLimit: f.userLimit || null } : {}) });
      useData.getState().apply('CHANNEL_UPDATE', { ...ch, ...u }); toast('Channel updated', 'success'); } catch (e) { toastError(e); } setBusy(false);
  };
  const saveOws = async () => {
    setBusy(true);
    try {
      const old = ch.overwrites ?? [];
      for (const o of ows) { const prev = old.find((x) => x.id === o.id); if (!prev || prev.allow !== o.allow || prev.deny !== o.deny) await api.channels.putOverwrite(ch.id, o); }
      for (const o of old) if (!ows.find((x) => x.id === o.id)) await api.channels.deleteOverwrite(ch.id, o.id);
      useData.getState().apply('CHANNEL_UPDATE', { ...ch, overwrites: ows }); toast('Permissions saved', 'success');
    } catch (e) { toastError(e); } setBusy(false);
  };
  const cur = ows.find((o) => o.id === sel);
  const addables = [...Object.values(g.roles).map((r) => ({ id: r.id, type: 'role' as const, name: r.name, color: r.color })), ...Object.values(g.members).slice(0, 200).map((m) => ({ id: m.user.id, type: 'member' as const, name: displayName(m.user, m), color: 0 }))].filter((x) => !ows.find((o) => o.id === x.id));
  const [adding, setAdding] = useState(false); const [aq, setAq] = useState('');
  return (
    <SettingsLayout title={`#${ch.name}`} tab={tab} onTab={setTab} onClose={close}
      groups={[{ title: ch.name ?? 'Channel', items: [{ id: 'overview', label: 'Overview', icon: Cog }, { id: 'permissions', label: 'Permissions', icon: Lock }] }, { items: [{ id: 'delete', label: 'Delete Channel', icon: Trash2, danger: true }] }]}>
      {tab === 'overview' && (<>
        <H1>Overview</H1>
        <Field label="Channel Name"><div className="relative">{ch.type !== 'category' && <Hash size={16} className="absolute left-2.5 top-3 text-muted" />}<input className={cx('field', ch.type !== 'category' && 'pl-8')} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div></Field>
        {ch.type !== 'category' && <Field label="Channel Topic"><textarea className="field min-h-[100px]" value={f.topic} maxLength={1024} onChange={(e) => setF({ ...f, topic: e.target.value })} placeholder="Let everyone know how to use this channel!" /></Field>}
        {(ch.type === 'text' || ch.type === 'forum' || ch.type === 'announcement') && <Field label="Slowmode" hint="Members will be restricted to sending one message and creating one thread per this interval, unless they have Manage Channel or Manage Messages permissions."><select className="field" value={f.slowmode} onChange={(e) => setF({ ...f, slowmode: Number(e.target.value) })}>{SLOWMODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>}
        {ch.type === 'voice' && <><Field label={`Bitrate: ${Math.round(f.bitrate / 1000)}kbps`}><input type="range" min={8000} max={510000} step={1000} value={f.bitrate} onChange={(e) => setF({ ...f, bitrate: Number(e.target.value) })} className="w-full accent-brand" aria-label="Bitrate" /></Field><Field label={`User limit: ${f.userLimit || 'No limit'}`}><input type="range" min={0} max={99} value={f.userLimit} onChange={(e) => setF({ ...f, userLimit: Number(e.target.value) })} className="w-full accent-brand" aria-label="User limit" /></Field></>}
        {ch.type !== 'category' && <div className="flex items-center justify-between border-t border-divider py-4"><div><div className="font-medium text-header">Age-Restricted Channel</div><div className="text-sm text-muted">Users will need to confirm they are of legal age to view the content.</div></div><Toggle label="Age-restricted" checked={f.nsfw} onChange={(v) => setF({ ...f, nsfw: v })} /></div>}
        <SaveBar dirty={dirtyOverview} busy={busy} onSave={saveOverview} onReset={() => setF({ name: ch.name ?? '', topic: ch.topic ?? '', nsfw: ch.nsfw, slowmode: ch.slowmode, bitrate: ch.bitrate ?? 64000, userLimit: ch.userLimit ?? 0 })} />
      </>)}
      {tab === 'permissions' && (<>
        <H1>Channel Permissions</H1>
        <p className="mb-4 text-sm text-muted">Use permissions to customize who can do what in this channel. Overwrites here take priority over server-wide role permissions.</p>
        <div className="flex flex-col gap-4 md:flex-row">
          <div className="md:w-52 md:shrink-0">
            <div className="mb-2 flex items-center justify-between"><span className="section-title">Roles / Members</span><button aria-label="Add role or member" onClick={() => setAdding(!adding)} className="text-interactive hover:text-header"><Plus size={18} /></button></div>
            {adding && <div className="mb-2 rounded bg-float p-2"><input className="field mb-1 !min-h-[32px]" placeholder="Search" value={aq} onChange={(e) => setAq(e.target.value)} autoFocus /><ul className="max-h-48 overflow-y-auto">{addables.filter((a) => a.name.toLowerCase().includes(aq.toLowerCase())).slice(0, 30).map((a) => <li key={a.id}><button className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-hover" onClick={() => { setOws([...ows, { id: a.id, type: a.type, allow: '0', deny: '0' }]); setSel(a.id); setAdding(false); setAq(''); }}>{a.type === 'role' ? <Shield size={14} style={{ color: a.color ? intToHex(a.color) : undefined }} /> : <UserIcon size={14} />}{a.name}</button></li>)}</ul></div>}
            <ul className="space-y-0.5">{ows.map((o) => <li key={o.id}><button onClick={() => setSel(o.id)} aria-current={sel === o.id} className={cx('flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm font-medium', sel === o.id ? 'bg-active text-header' : 'text-interactive hover:bg-hover')}>{o.type === 'role' ? <Shield size={14} style={{ color: g.roles[o.id]?.color ? intToHex(g.roles[o.id].color) : undefined }} /> : <UserIcon size={14} />}<span className="truncate">{label(o)}</span></button></li>)}</ul>
            {!ows.length && <p className="text-sm text-muted">No overwrites. Add a role to begin.</p>}
          </div>
          <div className="min-w-0 flex-1">
            {cur ? (<><div className="mb-3 flex items-center justify-between"><H3>{label(cur)}</H3><button className="text-sm text-danger hover:underline" onClick={() => { setOws(ows.filter((o) => o.id !== cur.id)); setSel(null); }}>Remove</button></div><OverwriteGrid ow={cur} onChange={(v) => setOws(ows.map((o) => (o.id === cur.id ? { ...o, ...v } : o)))} /></>) : <p className="text-muted">Select a role or member.</p>}
          </div>
        </div>
        <SaveBar dirty={dirtyOws} busy={busy} onSave={saveOws} onReset={() => setOws(ch.overwrites ?? [])} />
      </>)}
      {tab === 'delete' && (<><H1>Delete Channel</H1><p className="mb-4 text-muted">Deleting a channel removes all of its messages permanently.</p><button className="btn btn-danger btn-lg" onClick={() => openModal({ kind: 'confirm', title: 'Delete Channel', body: `Are you sure you want to delete #${ch.name}? This cannot be undone.`, confirmLabel: 'Delete Channel', danger: true, onConfirm: async () => { try { await api.channels.delete(ch.id); } catch (e) { toastError(e); } } })}>Delete Channel</button></>)}
    </SettingsLayout>
  );
}
