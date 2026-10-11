import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bot, Download, Search } from 'lucide-react';
import { DIRECTORY_CATEGORIES, type DirectoryApp, type DirectoryCategory } from '@jorcord/shared';
import { api } from '@/lib/api';
import { Empty, Spinner } from '@/components/ui/primitives';
import { cx, fileUrl, idColor, initials } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { useNav } from '@/lib/nav';
import { categoryName, installPath, installsLabel, permissionSummary } from '@/lib/directory';
import { t } from '@/i18n';

function AppCard({ a }: { a: DirectoryApp }) {
  const nav = useNav(); const icon = fileUrl(a.icon);
  return (
    <li data-app-card={a.id} className="flex flex-col rounded-lg bg-side p-4 shadow-high transition-shadow hover:shadow-elev">
      <div className="mb-2 flex items-center gap-3">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl text-base font-bold text-white" style={{ background: icon ? undefined : idColor(a.id) }}>{icon ? <img loading="lazy" decoding="async" src={icon} alt="" className="h-full w-full object-cover" /> : initials(a.name)}</div>
        <div className="min-w-0"><h3 className="flex items-center gap-1.5 truncate text-base font-bold text-header">{a.name}<span className="rounded bg-brand px-1 text-[10px] font-bold uppercase text-white">{t('Bot')}</span></h3><span className="text-xs text-muted">{t(categoryName(a.category))} • {installsLabel(a.installs)} {a.installs === 1 ? t('server') : t('servers')}</span></div>
      </div>
      <p className="line-clamp-3 min-h-[3.9rem] text-sm text-normal">{a.summary || a.description}</p>
      {a.tags.length > 0 && <ul className="mt-2 flex flex-wrap gap-1">{a.tags.map((x) => <li key={x} className="rounded bg-hover px-1.5 text-xs text-muted">#{x}</li>)}</ul>}
      <p className="mt-2 text-xs text-muted">{t('Asks for')}: {t(permissionSummary(a.permissions))}</p>
      <div className="mt-3 flex justify-end"><button className="btn btn-primary" aria-label={`${t('Add')} ${a.name} ${t('to a server')}`} onClick={() => nav.to(installPath(a))}><Download size={14} className="me-1 inline" />{t('Add to Server')}</button></div>
    </li>
  );
}

/** Discover > Apps: public bots their owners listed, searchable by category. "Add to Server" opens the normal OAuth2 add-bot page. */
export function AppDirectory() {
  const [q, setQ] = useState(''); const dq = useDebounced(q, 300); const [category, setCategory] = useState<DirectoryCategory | ''>(''); const [sort, setSort] = useState<'popular' | 'new'>('popular');
  const cats = useQuery({ queryKey: ['directory-cats'], queryFn: api.directory.categories, retry: false, staleTime: 60_000 });
  const res = useQuery({ queryKey: ['directory', dq, category, sort], queryFn: () => api.directory.apps({ q: dq || undefined, category, sort, limit: 48 }), retry: false });
  const count = (id: string) => cats.data?.find((c) => c.id === id)?.count ?? 0;
  return (
    <div data-testid="app-directory" className="mx-auto max-w-[1100px] px-4 pb-10">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex min-w-[220px] flex-1 items-center rounded-lg bg-input px-3"><input aria-label={t('Search apps')} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search bots and apps')} className="h-10 flex-1 bg-transparent outline-none" /><Search size={18} className="text-muted" /></div>
        <select aria-label={t('Sort apps')} className="field !w-auto" value={sort} onChange={(e) => setSort(e.target.value as 'popular' | 'new')}><option value="popular">{t('Most popular')}</option><option value="new">{t('Newest')}</option></select>
      </div>
      <div role="group" aria-label={t('Categories')} className="mb-5 flex flex-wrap gap-2">
        {[{ id: '' as const, name: 'All' }, ...DIRECTORY_CATEGORIES].map((c) => (
          <button key={c.id} aria-pressed={category === c.id} onClick={() => setCategory(c.id as DirectoryCategory | '')} className={cx('rounded-full px-3 py-1 text-sm font-medium', category === c.id ? 'bg-brand text-white' : 'bg-side text-interactive hover:bg-hover')}>{t(c.name)}{c.id && cats.data ? ` (${count(c.id)})` : ''}</button>))}
      </div>
      {res.isLoading && <Spinner className="mx-auto my-10" />}
      {res.isError && <Empty icon={<Bot size={40} />} title={t('The App Directory is unavailable')}>{t('This server does not provide a directory.')}</Empty>}
      {res.data && !res.data.items.length && <Empty icon={<Bot size={40} />} title={dq || category ? t('No apps found') : t('No apps listed yet')}>{dq || category ? t('Try a different search or category.') : t('App developers can list their public bot from the Developer Portal.')}</Empty>}
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">{res.data?.items.map((a) => <AppCard key={a.id} a={a} />)}</ul>
    </div>
  );
}
