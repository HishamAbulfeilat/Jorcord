import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Hash, Shield, Trash2, User as UserIcon, Plus, Bot } from 'lucide-react';
import type { ApplicationCommand, CommandPermissionOverwrite } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { toast, toastError } from '@/stores/ui';
import { H1, H3, SaveBar } from './SettingsLayout';
import { Empty, Field, Spinner } from '@/components/ui/primitives';
import { displayName } from '@/lib/format';
import { t } from '@/i18n';

const TYPE_LABEL = { 1: 'Role', 2: 'Member', 3: 'Channel' } as const;
const same = (a: CommandPermissionOverwrite[], b: CommandPermissionOverwrite[]) => JSON.stringify(a) === JSON.stringify(b);

/** Server settings: per-command (or app-wide default) role/user/channel allow/deny overrides. Contract: "Application commands" permissions. */
export function CommandPermissions({ guildId }: { guildId: string }) {
  const g = useData((s) => s.guilds[guildId])!;
  const qc = useQueryClient();
  const catalog = useQuery({ queryKey: ['command-catalog', guildId], queryFn: () => api.guilds.commands(guildId) });
  const apps = catalog.data?.applications ?? [];
  const [appId, setAppId] = useState('');
  const [target, setTarget] = useState(''); // command id, or the app id for the app-wide default
  useEffect(() => { if (!appId && apps[0]) setAppId(apps[0].id); }, [apps, appId]);
  const cmds = useMemo(() => { const seen = new Set<string>(); return (catalog.data?.commands ?? []).filter((c) => c.applicationId === appId && !seen.has(c.id) && seen.add(c.id)); }, [catalog.data, appId]);
  useEffect(() => { setTarget(appId); }, [appId]);
  const cmd: ApplicationCommand | undefined = cmds.find((c) => c.id === target);

  const perms = useQuery({ queryKey: ['command-perms', guildId, appId, target], enabled: !!appId && !!target, queryFn: () => api.applications.getCommandPermissions(appId, guildId, target) });
  const saved = perms.data?.permissions;
  const [draft, setDraft] = useState<CommandPermissionOverwrite[]>([]);
  useEffect(() => { if (saved) setDraft(saved); }, [saved]);
  const dirty = !!saved && !same(saved, draft);
  const [busy, setBusy] = useState(false);
  const [addType, setAddType] = useState<1 | 2 | 3>(1); const [addId, setAddId] = useState('');

  const roles = Object.values(g.roles).sort((a, b) => b.position - a.position);
  const members = Object.values(g.members).sort((a, b) => displayName(a.user).localeCompare(displayName(b.user)));
  const channels = Object.values(g.channels).filter((c) => c.type !== 'category').sort((a, b) => a.position - b.position);
  const options = addType === 1 ? roles.map((r) => ({ id: r.id, name: r.id === g.guild.id ? '@everyone' : r.name })) : addType === 2 ? members.map((m) => ({ id: m.user.id, name: displayName(m.user) })) : channels.map((c) => ({ id: c.id, name: `#${c.name ?? ''}` }));
  const nameOf = (e: CommandPermissionOverwrite) => e.type === 1 ? (e.id === g.guild.id ? '@everyone' : g.roles[e.id]?.name ?? e.id) : e.type === 2 ? (g.members[e.id] ? displayName(g.members[e.id]!.user) : e.id) : `#${g.channels[e.id]?.name ?? e.id}`;
  const taken = new Set(draft.map((e) => `${e.type}:${e.id}`));
  const available = options.filter((o) => !taken.has(`${addType}:${o.id}`));
  useEffect(() => { setAddId(available[0]?.id ?? ''); }, [addType, draft.length, target]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setBusy(true);
    try { const r = await api.applications.putCommandPermissions(appId, guildId, target, draft); qc.setQueryData(['command-perms', guildId, appId, target], r); setDraft(r.permissions); toast(t('Command permissions saved')); }
    catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const Icon = (e: CommandPermissionOverwrite) => e.type === 1 ? Shield : e.type === 2 ? UserIcon : Hash;

  return (<>
    <H1>{t('Command Permissions')}</H1>
    <p className="mb-4 text-sm text-muted">{t('Choose who can use each app command. Overrides apply in this order: channel deny, member, role, @everyone, then the command default. Administrators always pass.')}</p>
    {catalog.isLoading ? <Spinner /> : !apps.length ? <Empty icon={<Bot size={32} />} title={t('No apps installed')}>{t('Add an app to this server to manage its command permissions.')}</Empty> : (<>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field label={t('Application')}><select className="field" data-testid="cmdperm-app" value={appId} onChange={(e) => setAppId(e.target.value)}>{apps.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        <Field label={t('Command')}><select className="field" data-testid="cmdperm-command" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value={appId}>{t('All commands (app default)')}</option>
          {cmds.map((c) => <option key={c.id} value={c.id}>{c.type === 1 ? '/' : ''}{c.name}</option>)}
        </select></Field>
      </div>
      {cmd && <p className="mb-2 text-sm text-muted">{cmd.description}{cmd.defaultMemberPermissions ? ` ${t('Default requires specific permissions.')}` : ` ${t('Default: everyone.')}`}</p>}
      <H3>{t('Overrides')}</H3>
      {perms.isLoading ? <Spinner /> : !draft.length ? <p className="py-3 text-sm text-muted" data-testid="cmdperm-empty">{t('No overrides. The command default applies.')}</p> : (
        <ul className="divide-y divide-divider/60 rounded-md bg-side" data-testid="cmdperm-list" aria-label={t('Overrides')}>
          {draft.map((e) => { const I = Icon(e); return (
            <li key={`${e.type}:${e.id}`} className="flex items-center gap-3 px-3 py-2" data-override={`${e.type}:${e.id}`}>
              <I size={16} className="shrink-0 text-muted" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-header"><span className="sr-only">{t(TYPE_LABEL[e.type])}: </span>{nameOf(e)}</span>
              <select className="field !w-auto" aria-label={t('Permission for {name}', { name: nameOf(e) })} value={e.permission ? 'allow' : 'deny'} onChange={(ev) => setDraft(draft.map((x) => x === e ? { ...x, permission: ev.target.value === 'allow' } : x))}>
                <option value="allow">{t('Allow')}</option><option value="deny">{t('Deny')}</option>
              </select>
              <button className="touch p-2 text-danger" aria-label={t('Remove override for {name}', { name: nameOf(e) })} onClick={() => setDraft(draft.filter((x) => x !== e))}><Trash2 size={16} /></button>
            </li>); })}
        </ul>)}
      <H3>{t('Add override')}</H3>
      <div className="flex flex-wrap items-end gap-2">
        <label className="block"><span className="label">{t('Type')}</span><select className="field" data-testid="cmdperm-type" value={addType} onChange={(e) => setAddType(Number(e.target.value) as 1 | 2 | 3)}><option value={1}>{t('Role')}</option><option value={2}>{t('Member')}</option><option value={3}>{t('Channel')}</option></select></label>
        <label className="block min-w-[180px] flex-1"><span className="label">{t('Target')}</span><select className="field" data-testid="cmdperm-target" value={addId} onChange={(e) => setAddId(e.target.value)}>{available.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
        <button className="btn btn-secondary mb-0" disabled={!addId || draft.length >= 100} onClick={() => setDraft([...draft, { id: addId, type: addType, permission: addType !== 3 }])}><Plus size={16} />{t('Add')}</button>
      </div>
    </>)}
    <SaveBar dirty={dirty} busy={busy} onSave={save} onReset={() => setDraft(saved ?? [])} />
  </>);
}
