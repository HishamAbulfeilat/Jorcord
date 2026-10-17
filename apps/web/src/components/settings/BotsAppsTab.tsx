import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, ChevronDown, Plus, Trash2 } from 'lucide-react';
import { ALL_PERMS, Perm, type GuildIntegration, type PermName } from '@jorcord/shared';
import { api } from '@/lib/api';
import { addAppPath, permissionSummary } from '@/lib/directory';
import { navigateTo } from '@/lib/navigate';
import { permissionNames } from '@/lib/oauth';
import { cx, fileUrl, idColor, initials } from '@/lib/format';
import { toast, toastError, useUI } from '@/stores/ui';
import { Spinner } from '@/components/ui/primitives';
import { H1 } from './SettingsLayout';
import { PermGrid } from './PermGrid';
import { t } from '@/i18n';

/**
 * Server Settings > Bots & Apps: every app installed in the server with what its bot role may do. Managers can change those permissions
 * (only up to what they hold themselves; the server enforces it) or remove the app, which kicks its bot.
 */
export function BotsAppsTab({ guildId, myPerms }: { guildId: string; myPerms: bigint }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['integrations', guildId], queryFn: () => api.guilds.integrations(guildId), retry: false });
  const rows = q.data ?? [];
  const refetch = () => qc.invalidateQueries({ queryKey: ['integrations', guildId] });
  return (<div data-testid="bots-apps-tab">
    <H1>{t('Bots & Apps')}</H1>
    <p className="mb-4 text-sm text-muted">{t('Apps added to this server and what their bot is allowed to do. Removing an app kicks its bot and deletes its role.')}</p>
    <button className="btn btn-primary mb-4" onClick={() => { useUI.getState().openSettings(null); navigateTo(addAppPath(guildId)); }}><Plus size={14} className="me-1 inline" />{t('Add App')}</button>
    {q.isLoading && <Spinner />}
    {q.isError && <p role="alert" className="text-sm text-danger">{t('Could not load the installed apps.')}</p>}
    {!q.isLoading && !q.isError && rows.length === 0 && <p className="text-sm text-muted">{t('No apps are installed yet. Use Add App to browse the App Directory.')}</p>}
    <ul className="space-y-3">{rows.map((r) => <AppRow key={r.applicationId} guildId={guildId} row={r} myPerms={myPerms} onChanged={() => void refetch()} />)}</ul>
  </div>);
}

function AppRow({ guildId, row, myPerms, onChanged }: { guildId: string; row: GuildIntegration; myPerms: bigint; onChanged: () => void }) {
  const [open, setOpen] = useState(false); const [bits, setBits] = useState(row.permissions); const [busy, setBusy] = useState(false);
  const icon = fileUrl(row.icon); const dirty = bits !== row.permissions;
  // you can switch things off freely, but only switch on what you hold yourself
  const locked = useMemo((): PermName[] => {
    if (myPerms & Perm.ADMINISTRATOR) return [];
    const have = new Set(permissionNames(row.permissions));
    return permissionNames(ALL_PERMS & ~myPerms).filter((n) => !have.has(n));
  }, [myPerms, row.permissions]);
  const save = async () => {
    setBusy(true);
    try { await api.guilds.patchIntegration(guildId, row.applicationId, bits); toast(t('Permissions updated'), 'success'); onChanged(); } catch (e) { toastError(e); }
    setBusy(false);
  };
  const remove = () => useUI.getState().openModal({
    kind: 'confirm', title: t('Remove {name}?', { name: row.name }), body: t('The bot is kicked from the server and its role is deleted. You can add it again at any time.'), confirmLabel: t('Remove'), danger: true,
    onConfirm: () => api.guilds.removeIntegration(guildId, row.applicationId).then(() => { toast(t('{name} was removed', { name: row.name }), 'success'); onChanged(); }).catch(toastError),
  });
  return (
    <li data-testid="integration" data-app={row.applicationId} className="rounded-lg border border-divider bg-side p-4">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl text-sm font-bold text-white" style={{ background: icon ? undefined : idColor(row.applicationId) }}>{icon ? <img src={icon} alt="" className="h-full w-full object-cover" /> : initials(row.name)}</div>
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-1.5 truncate font-semibold text-header">{row.name}
            <span className="rounded bg-brand px-1 text-[10px] font-bold uppercase text-white">{t('Bot')}</span>
            {row.official && <span data-testid="official-badge" className="flex items-center gap-0.5 rounded bg-success px-1 text-[10px] font-bold uppercase text-white"><BadgeCheck size={10} aria-hidden />{t('Official')}</span>}
          </h2>
          <p className="truncate text-xs text-muted">{row.roleId ? t(permissionSummary(row.permissions, 4)) : t('Slash commands only (no bot user)')}</p>
        </div>
        {row.roleId && <button className="btn btn-secondary" aria-expanded={open} aria-label={t('Permissions of {name}', { name: row.name })} onClick={() => setOpen((o) => !o)}>{t('Permissions')}<ChevronDown size={14} className={cx('ms-1 inline transition-transform', open && 'rotate-180')} /></button>}
        <button className="p-2 text-danger" aria-label={t('Remove {name}', { name: row.name })} onClick={remove}><Trash2 size={18} /></button>
      </div>
      {row.description && <p className="mt-2 text-sm text-normal">{row.description}</p>}
      {open && row.roleId && (<div className="mt-4" data-testid="integration-perms">
        <PermGrid bits={bits} onChange={setBits} disabledPerms={locked} />
        <div className="mt-3 flex justify-end gap-2"><button className="btn btn-secondary" disabled={!dirty || busy} onClick={() => setBits(row.permissions)}>{t('Reset')}</button><button className="btn btn-primary" disabled={!dirty || busy} onClick={() => void save()}>{t('Save Changes')}</button></div>
      </div>)}
    </li>
  );
}

