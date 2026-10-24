import { useState } from 'react';
import { useData } from '@/stores/data';
import { api } from '@/lib/api';
import { toast, toastError } from '@/stores/ui';
import { Row, Toggle } from '@/components/ui/primitives';
import { t } from '@/i18n';
import type { Id } from '@jorcord/shared';

/** Server Settings: opt-in public web view (readable and indexable without an account). Community servers only; see docs/PUBLIC_PAGES.md. */
export function PublicWebPanel({ guildId }: { guildId: Id }) {
  const gd = useData((s) => s.guilds[guildId]); const [busy, setBusy] = useState(false);
  if (!gd) return null;
  const g = gd.guild as any; const community = gd.guild.features.includes('COMMUNITY');
  const chans = Object.values(gd.channels).filter((c) => (c.type === 'forum' || c.type === 'announcement') && !c.nsfw);
  const patchGuild = async (b: Record<string, boolean>) => { setBusy(true); try { const u = await api.guilds.patch(guildId, b as any); useData.getState().apply('GUILD_UPDATE', { ...gd.guild, ...u }); } catch (e) { toastError(e); } setBusy(false); };
  const patchChannel = async (id: Id, publicWeb: boolean) => { setBusy(true); try { const u = await api.channels.patch(id, { publicWeb } as any); useData.getState().apply('CHANNEL_UPDATE', u); toast(publicWeb ? t('Channel is now public') : t('Channel is no longer public'), 'success'); } catch (e) { toastError(e); } setBusy(false); };
  return (<div data-testid="public-web-panel" className="mb-4">
    <Row title={t('Public web view')} desc={community ? t('Lets anyone read selected forum and announcement channels without an account, and lets search engines index them. Only the channels you switch on below are published; age-restricted channels never are.') : t('Turn on Community first.')}>
      <Toggle label={t('Public web view')} checked={!!g.publicWeb && community} disabled={!community || busy} onChange={(v) => void patchGuild({ publicWeb: v })} />
    </Row>
    {community && g.publicWeb && (<>
      <Row title={t('Allow search engines')} desc={t('Off adds noindex: pages stay readable by link but are left out of sitemaps and search results.')}>
        <Toggle label={t('Allow search engines')} checked={!g.publicNoindex} disabled={busy} onChange={(v) => void patchGuild({ publicNoindex: !v })} />
      </Row>
      {chans.length === 0 && <p className="text-sm text-muted">{t('No forum or announcement channels yet.')}</p>}
      {chans.map((c) => <Row key={c.id} title={`#${c.name}`} desc={c.type === 'forum' ? t('Forum posts') : t('Announcements')}><Toggle label={`#${c.name}`} checked={!!(c as any).publicWeb} disabled={busy} onChange={(v) => void patchChannel(c.id, v)} /></Row>)}
      <p className="text-xs text-muted">{t('Members can hide their name and avatar on public pages in their own Privacy settings. Edits and deletions appear within about a minute.')}</p>
    </>)}
  </div>);
}
