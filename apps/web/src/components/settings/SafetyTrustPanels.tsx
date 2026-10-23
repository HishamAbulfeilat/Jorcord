/** Safety Setup sections for member DMs, scam-link lists and the impersonation guard (all enforced by the server; see docs/SAFETY.md). */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { normalizeLinkList, type GuildSafety, type Id } from '@jorcord/shared';
import { api } from '@/lib/api';
import { toast, toastError } from '@/stores/ui';
import { H3 } from './SettingsLayout';
import { Row, Toggle } from '@/components/ui/primitives';
import { AccountAge } from '@/components/ui/TrustBits';
import { t } from '@/i18n';

type Patch = Parameters<typeof api.guilds.patchSafety>[1];

export function MemberDmsSection({ s, patch }: { s: GuildSafety; patch: (b: Patch) => void }) {
  const optin = s.memberDms === 'optin';
  return (<div data-testid="member-dms-section">
    <H3>{t('Direct messages between members')}</H3>
    <Row title={t('Members must opt in to DMs')} desc={t('New members can only be messaged through this server after they switch it on in their Privacy settings. Friends and message requests from other servers are not affected.')}>
      <Toggle label={t('Members must opt in to DMs')} checked={optin} onChange={(v) => patch({ memberDms: v ? 'optin' : 'open' })} />
    </Row>
    {optin && <Row title={t('Also require existing members to opt in')} desc={t('Everyone who is already here is asked again. Without this, current members keep working as before.')}>
      <button className="btn btn-secondary" onClick={() => patch({ memberDms: 'optin', memberDmsApplyToExisting: true })}>{t('Apply to everyone')}</button>
    </Row>}
  </div>);
}

function ListEditor({ label, items, onSave, hint }: { label: string; items: string[]; onSave: (next: string[]) => void; hint: string }) {
  const [v, setV] = useState('');
  const add = () => { const next = normalizeLinkList([...items, v]); if (next.length === items.length) { toast(t('Enter a domain like example.com'), 'error'); return; } setV(''); onSave(next); };
  return (<div className="mb-3 rounded-lg bg-side p-3">
    <div className="mb-1 font-semibold text-header">{label}</div>
    <p className="mb-2 text-xs text-muted">{hint}</p>
    <form className="mb-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); add(); }}>
      <input className="field flex-1" aria-label={label} placeholder="example.com" value={v} maxLength={253} onChange={(e) => setV(e.target.value)} />
      <button type="submit" className="btn btn-secondary" disabled={!v.trim()}>{t('Add')}</button>
    </form>
    {items.length === 0 ? <p className="text-sm text-muted">{t('Nothing here yet.')}</p> : (
      <ul className="flex flex-wrap gap-2">{items.map((d) => <li key={d} className="flex items-center gap-1 rounded bg-active px-2 py-1 text-sm text-header">{d}<button aria-label={t('Remove {d}', { d })} className="text-interactive hover:text-header" onClick={() => onSave(items.filter((x) => x !== d))}><X size={14} /></button></li>)}</ul>
    )}
  </div>);
}

export function LinkListsSection({ s, patch }: { s: GuildSafety; patch: (b: Patch) => void }) {
  return (<div data-testid="link-lists-section">
    <H3>{t('Scam and phishing links')}</H3>
    <p className="mb-2 text-sm text-muted">{t('Jorcord scores every link locally (look-alike domains, disguised characters, free Nitro bait) and warns readers. Add an AutoMod rule of type "Suspicious links" to block or flag them as well.')}</p>
    <ListEditor label={t('Always trust these domains')} hint={t('Never warned about or blocked. Subdomains are included.')} items={s.linkAllow ?? []} onSave={(next) => patch({ linkAllow: next })} />
    <ListEditor label={t('Always block these domains')} hint={t('Always shown as dangerous and caught by the Suspicious links rule. Wins over the trusted list.')} items={s.linkDeny ?? []} onSave={(next) => patch({ linkDeny: next })} />
  </div>);
}

export function ImpersonationSection({ guildId, s, patch }: { guildId: Id; s: GuildSafety; patch: (b: Patch) => void }) {
  const g = s.impersonationGuard ?? { enabled: false, action: 'flag' as const };
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['impersonation', guildId], queryFn: () => api.guilds.impersonationQueue(guildId), enabled: g.enabled });
  const clear = (userId: Id) => api.guilds.clearImpersonation(guildId, userId).then(() => { toast(t('Cleared'), 'success'); void qc.invalidateQueries({ queryKey: ['impersonation', guildId] }); }).catch(toastError);
  return (<div data-testid="impersonation-section">
    <H3>{t('Impersonation guard')}</H3>
    <Row title={t('Watch for look-alike names')} desc={t('Members whose username, display name or nickname closely matches the owner, a moderator or this server\'s name (including swapped letters like I and l, or Cyrillic look-alikes) are flagged for review.')}>
      <Toggle label={t('Watch for look-alike names')} checked={g.enabled} onChange={(v) => patch({ impersonationGuard: { enabled: v } })} />
    </Row>
    {g.enabled && <Row title={t('Hold suspected impersonators')} desc={t('They can read but not talk until a moderator clears them. Without this they are only flagged.')}>
      <Toggle label={t('Hold suspected impersonators')} checked={g.action === 'hold'} onChange={(v) => patch({ impersonationGuard: { action: v ? 'hold' : 'flag' } })} />
    </Row>}
    {g.enabled && <div className="mb-3 rounded-lg bg-side p-3" data-testid="impersonation-queue">
      <div className="mb-2 font-semibold text-header">{t('Review queue')}</div>
      {!q.data?.length ? <p className="text-sm text-muted">{t('No one is flagged.')}</p> : (
        <ul className="space-y-2">{q.data.map((e) => (
          <li key={e.userId} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="min-w-0 flex-1"><span className="font-semibold text-header">{e.displayName ?? e.username}</span>{' '}
              <span className="text-muted">{t('looks like')} {e.match.target}{e.held ? ` · ${t('held')}` : ''}</span> <AccountAge createdAt={e.accountCreatedAt} /></span>
            <button className="btn btn-secondary" onClick={() => void clear(e.userId)}>{t('Not an impersonator')}</button>
          </li>))}</ul>)}
    </div>}
  </div>);
}
