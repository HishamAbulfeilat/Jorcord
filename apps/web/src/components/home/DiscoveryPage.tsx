import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Compass, Menu, Search, Users } from 'lucide-react';
import type { Guild } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { useUI, toastError } from '@/stores/ui';
import { Empty, Spinner } from '@/components/ui/primitives';
import { cx, fileUrl, idColor, initials } from '@/lib/format';
import { useDebounced, useIsMobile } from '@/lib/hooks';
import { useNav } from '@/lib/nav';
import { t, tn } from '@/i18n';
import { AppDirectory } from './AppDirectory';

type Found = Guild & { approxMembers?: number };

/** Join a discoverable server with `POST /discover/guilds/:id/join` (an invite is not needed); older servers without it fall back to the vanity code. */
export async function joinDiscoverable(g: Found) {
  try { return await api.guilds.joinDiscoverable(g.id); }
  catch (e) { if (g.vanityUrl && (e as { status?: number }).status === 404) return api.invites.join(g.vanityUrl); throw e; }
}

function Card({ g }: { g: Found }) {
  const nav = useNav(); const joined = useData((s) => !!s.guilds[g.id]); const [busy, setBusy] = useState(false);
  const banner = fileUrl(g.banner); const icon = fileUrl(g.icon);
  const join = async () => {
    setBusy(true);
    try { const r = await joinDiscoverable(g); const full = (r as any).guild ?? r; if (full?.channels) useData.getState().putGuild(full); nav.go(g.id); }
    catch (e) { toastError(e); }
    setBusy(false);
  };
  return (
    <li data-guild-card={g.id} className="flex flex-col overflow-hidden rounded-lg bg-side shadow-high transition-shadow hover:shadow-elev">
      <div className="h-24 shrink-0" style={banner ? { background: `center/cover url(${banner})` } : { background: `linear-gradient(135deg, ${idColor(g.id)}, rgb(var(--brand)))` }} />
      <div className="relative flex flex-1 flex-col px-4 pb-4">
        <div className="-mt-7 mb-2 flex h-14 w-14 items-center justify-center overflow-hidden rounded-2xl border-4 border-[rgb(var(--side))] bg-brand text-lg font-bold text-white">{icon ? <img loading="lazy" decoding="async" src={icon} alt="" className="h-full w-full object-cover" /> : initials(g.name)}</div>
        <h3 className="truncate text-base font-bold text-header">{g.name}</h3>
        <p className="mt-1 line-clamp-3 min-h-[3.9rem] text-sm text-muted">{g.description || t('No description yet.')}</p>
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="flex items-center gap-1 text-xs font-medium text-muted"><Users size={14} />{tn(g.approxMembers ?? 0, '{n} member', '{n} members')}</span>
          {joined ? <button className="btn btn-secondary" onClick={() => nav.go(g.id)}>{t('Open')}</button> : <button className="btn btn-primary" disabled={busy} onClick={join}>{t('Join')}</button>}
        </div>
      </div>
    </li>
  );
}

export function DiscoveryPage() {
  const [sp] = useSearchParams(); const [tab, setTab] = useState<'servers' | 'apps'>(sp.get('tab') === 'apps' ? 'apps' : 'servers'); const forGuild = sp.get('guild') ?? undefined; const [q, setQ] = useState(''); const dq = useDebounced(q, 300); const mobile = useIsMobile(); const setLeft = useUI((s) => s.setLeftDrawer);
  const res = useQuery({ queryKey: ['discover', dq], queryFn: () => api.guilds.discover(dq || undefined), retry: false });
  return (
    <div data-testid="discovery" className="flex h-full min-w-0 flex-1 flex-col bg-chat">
      <header className="flex h-12 shrink-0 items-center gap-2 px-2 shadow-[0_1px_0_rgb(0_0_0/0.2)] safe-top box-content md:px-4">
        {mobile && <button aria-label={t('Open navigation')} onClick={() => setLeft(true)} className="flex h-11 w-11 items-center justify-center text-interactive"><Menu size={24} /></button>}
        <Compass size={24} className="text-muted" /><h1 className="text-base font-semibold text-header">{t('Discover')}</h1>
      </header>
      <div role="tablist" aria-label={t('Discover')} className="flex gap-1 px-2 pt-2 md:px-4">
        {([['servers', 'Servers'], ['apps', 'Apps']] as const).map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={cx('rounded px-3 py-1.5 text-sm font-semibold', tab === id ? 'bg-hover text-header' : 'text-interactive hover:bg-hover')}>{t(label)}</button>)}
      </div>
      <div className="scroller min-h-0 flex-1">
        {tab === 'apps' ? <div className="pt-4"><AppDirectory guildId={forGuild} /></div> : <>
        <div className="relative mb-6 flex flex-col items-center gap-3 bg-gradient-to-br from-brand to-[#eb459e] px-6 py-10 text-center text-white">
          <h2 className="text-3xl font-extrabold">{t('Find your community on Jorcord')}</h2>
          <p className="max-w-lg text-white/90">{t('From gaming, to music, to learning, there is a place for you.')}</p>
          <div className="flex w-full max-w-xl items-center rounded-lg bg-white px-3 text-black"><input aria-label={t('Search discoverable servers')} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Explore communities')} className="h-11 flex-1 bg-transparent outline-none placeholder:text-black/50" /><Search size={20} className="text-black/60" /></div>
        </div>
        <div className="mx-auto max-w-[1100px] px-4 pb-10">
          <h2 className="section-title mb-3">{dq ? t('Search results') : t('Featured communities')}</h2>
          {res.isLoading && <Spinner className="mx-auto my-10" />}
          {res.isError && <Empty icon={<Compass size={40} />} title={t('Discovery is unavailable')}>{t('This server does not provide a directory.')}</Empty>}
          {res.data && !res.data.length && <Empty icon={<Compass size={40} />} title={dq ? t('No communities found') : t('Nothing to discover yet')}>{dq ? t('Try a different search term.') : t('Server owners can turn on Discovery in Server Settings.')}</Empty>}
          <ul className={cx('grid gap-4', 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3')}>{res.data?.map((g) => <Card key={g.id} g={g as Found} />)}</ul>
        </div></>}
      </div>
    </div>
  );
}
