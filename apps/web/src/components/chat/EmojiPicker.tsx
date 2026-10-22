import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, Smile, Clock, Film, Star, Sticker as StickerIcon, Zap } from 'lucide-react';
import { fileUrl } from '@/lib/format';
import { t } from '@/i18n';
import { EMOJI_CATEGORIES, searchEmoji } from '@/lib/emoji';
import { useData } from '@/stores/data';
import { api } from '@/lib/api';
import { cx } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { Spinner } from '@/components/ui/primitives';
import { LIMITS } from '@jorcord/shared';
import { effectivePerms } from '@/lib/perms';
import { canUseEmoji } from '@/lib/emojiRoles';

const GIF_PAGE = 30;
export type EmojiPick = { char?: string; name: string; id?: string; animated?: boolean; gif?: string; sticker?: string; burst?: boolean; burstColor?: string };
const RKEY = 'jorcord.recent.emoji';
const recent = (): string[] => { try { return JSON.parse(localStorage.getItem(RKEY) ?? '[]'); } catch { return []; } };
const pushRecent = (c: string) => { try { localStorage.setItem(RKEY, JSON.stringify([c, ...recent().filter((x) => x !== c)].slice(0, 24))); } catch { /* */ } };

export function EmojiPicker({ onPick, guildId, allowGif = false, allowSticker = false, allowBurst = false, initialTab = 'emoji', gifOnly = false }: { onPick: (e: EmojiPick) => void; guildId?: string; allowGif?: boolean; allowSticker?: boolean; allowBurst?: boolean; initialTab?: 'emoji' | 'gif' | 'sticker'; gifOnly?: boolean }) {
  const [q, setQ] = useState(''); const [tab, setTab] = useState<'emoji' | 'gif' | 'sticker'>(gifOnly ? 'gif' : initialTab); const [hover, setHover] = useState<string>('');
  const [burst, setBurst] = useState(false); const [burstColor, setBurstColor] = useState<string>(LIMITS.burstColors[0]);
  const guilds = useData((s) => s.guilds); const order = useData((s) => s.guildOrder);
  const dq = useDebounced(q, 250);
  const myId = useData((s) => s.me?.id);
  // role-restricted emoji are hidden from people who may not use them
  const custom = useMemo(() => order.map((id) => guilds[id]).filter(Boolean).map((g) => {
    const me = myId ? g!.members[myId] : undefined; const perms = effectivePerms({ guild: g!.guild, roles: Object.values(g!.roles), member: me! });
    return { ...g!, emojis: g!.emojis.filter((e) => canUseEmoji(e, me?.roles, perms)) };
  }).filter((g) => g.emojis.length), [guilds, order, myId]);
  const results = q ? searchEmoji(q, 90) : null;
  const customHits = q ? custom.flatMap((g) => g.emojis.filter((e) => e.name.toLowerCase().includes(q.toLowerCase().replace(/^:/, '')))) : [];
  const rec = recent();
  const [gifMode, setGifMode] = useState<'trending' | 'favorites'>('trending'); const qc = useQueryClient();
  // GIFs load a page at a time; more are fetched as the list is scrolled near its end
  const gifs = useInfiniteQuery({ queryKey: ['gifs', dq], initialPageParam: 0, queryFn: ({ pageParam }) => api.misc.gifs(dq || undefined, pageParam), getNextPageParam: (last, all) => (last.length ? all.length * GIF_PAGE : undefined), enabled: tab === 'gif' && gifMode === 'trending', staleTime: 60_000 });
  const gifItems = useMemo(() => { const seen = new Set<string>(); return (gifs.data?.pages.flat() ?? []).filter((g) => (seen.has(g.id) ? false : (seen.add(g.id), true))); }, [gifs.data]);
  const loadMoreGifs = () => { if (gifMode === 'trending' && gifs.hasNextPage && !gifs.isFetchingNextPage) void gifs.fetchNextPage(); };
  const favs = useQuery({ queryKey: ['gif-favs'], queryFn: () => api.users.gifFavorites(), enabled: tab === 'gif', staleTime: 30_000 });
  const favByUrl = useMemo(() => new Map((favs.data ?? []).map((f) => [f.url, f])), [favs.data]);
  const toggleFav = (g: { url: string; preview?: string | null; title?: string | null }) => {
    const ex = favByUrl.get(g.url);
    (ex ? api.users.removeGifFavorite(ex.id) : api.users.addGifFavorite({ url: g.url, preview: g.preview && /^https:/.test(g.preview) ? g.preview : null, title: g.title || null })).then(() => qc.invalidateQueries({ queryKey: ['gif-favs'] })).catch(() => {});
  };
  // Stable callbacks + module-level memo cells: hovering must not remount ~1800 buttons (that swallowed clicks).
  const onPickRef = useRef(onPick); onPickRef.current = onPick;
  const pickRef = useRef({ burst, burstColor, tab }); pickRef.current = { burst, burstColor, tab };
  const pick = useCallback((e: EmojiPick) => { if (e.char) pushRecent(e.char); const b = pickRef.current; onPickRef.current(b.burst && b.tab === 'emoji' ? { ...e, burst: true, burstColor: b.burstColor } : e); }, []);
  const setHoverStable = useCallback((v: string) => setHover(v), []);
  return (
    <div className="flex h-[min(420px,70dvh)] w-full flex-col overflow-hidden rounded-lg bg-float text-normal shadow-elev sm:w-[360px]" role="dialog" aria-label={gifOnly ? t('GIF picker') : 'Emoji picker'}>
      <div className="flex items-center gap-2 p-2">
        <div className="flex flex-1 items-center rounded bg-rail px-2"><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={tab === 'gif' ? 'Search GIFs' : 'Find the perfect emoji'} aria-label="Search" className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted" /><Search size={16} className="text-muted" /></div>
        {allowBurst && tab === 'emoji' && <button type="button" aria-pressed={burst} aria-label={t('Super reaction')} title={t('Super reaction')} onClick={() => setBurst((v) => !v)} className={cx('rounded p-1.5', burst ? 'bg-brand/30 text-header' : 'text-interactive hover:text-interactive-hover')}><Zap size={18} /></button>}
        {allowGif && !gifOnly && <div className="flex gap-1" role="tablist" aria-label={t('Picker type')}>
          <button aria-pressed={tab === 'emoji'} aria-label="Emoji" onClick={() => setTab('emoji')} className={cx('rounded p-1.5', tab === 'emoji' ? 'bg-active text-header' : 'text-interactive')}><Smile size={18} /></button>
          <button aria-pressed={tab === 'gif'} aria-label="GIFs" onClick={() => setTab('gif')} className={cx('rounded p-1.5', tab === 'gif' ? 'bg-active text-header' : 'text-interactive')}><Film size={18} /></button>
          {allowSticker && <button aria-pressed={tab === 'sticker'} aria-label={t('Stickers')} onClick={() => setTab('sticker')} className={cx('rounded p-1.5', tab === 'sticker' ? 'bg-active text-header' : 'text-interactive')}><StickerIcon size={18} /></button>}
        </div>}
      </div>
      {allowBurst && tab === 'emoji' && burst && <div className="flex items-center gap-1.5 px-2 pb-1" role="group" aria-label={t('Super reaction color')}>{LIMITS.burstColors.map((c) => <button key={c} type="button" aria-pressed={burstColor === c} aria-label={c} title={c} onClick={() => setBurstColor(c)} className={cx('h-5 w-5 rounded-full border-2', burstColor === c ? 'border-header' : 'border-transparent')} style={{ backgroundColor: c }} />)}</div>}
      {tab === 'sticker' ? (
        <StickerGrid guildId={guildId} q={q} onPick={(st) => pick({ name: st.name, sticker: st.id })} />
      ) : tab === 'gif' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex gap-1 px-2 pb-1" role="tablist" aria-label={t('GIF source')}>
            {(['trending', 'favorites'] as const).map((m) => <button key={m} role="tab" aria-selected={gifMode === m} onClick={() => setGifMode(m)} className={cx('rounded px-2 py-1 text-xs font-semibold', gifMode === m ? 'bg-active text-header' : 'text-interactive hover:bg-hover')}>{m === 'trending' ? t('Trending') : t('Favorites')}</button>)}
          </div>
          {/* two flex columns (not CSS multi-column: a fixed-height multi-column box grows sideways and never scrolls vertically) */}
          <div className="scroller min-h-0 flex-1 p-2" data-testid="gif-grid" onScroll={(e) => { const el = e.currentTarget; if (el.scrollHeight - el.scrollTop - el.clientHeight < 240) loadMoreGifs(); }}>
            {gifMode === 'favorites' && favs.data?.length === 0 && <p className="p-4 text-center text-sm text-muted">{t('No favorites yet. Star a GIF, or right-click an image in chat.')}</p>}
            {gifMode === 'trending' && gifs.isLoading && <Spinner className="mx-auto mt-8" />}
            {gifMode === 'trending' && !gifs.isLoading && gifItems.length === 0 && <p className="p-4 text-center text-sm text-muted">No GIFs available. The server has no GIF provider configured.</p>}
            <div className="flex items-start gap-1">
              {[0, 1].map((col) => (
                <div key={col} className="flex min-w-0 flex-1 flex-col gap-1">
                  {gifMode === 'favorites' && favs.data?.filter((f) => !dq || (f.title ?? '').toLowerCase().includes(dq.toLowerCase())).filter((_, i) => i % 2 === col).map((f) => (
                    <div key={f.id} className="group/g relative"><button className="block w-full overflow-hidden rounded" aria-label={f.title || 'GIF'} onClick={() => pick({ name: f.title ?? 'gif', gif: f.url })}><img src={fileUrl(f.preview ?? f.url) ?? f.url} alt={f.title ?? 'GIF'} loading="lazy" className="w-full" /></button>
                      <button aria-label={t('Remove from favorites')} onClick={() => toggleFav(f)} className="absolute end-1 top-1 rounded bg-black/60 p-1 text-warn opacity-0 focus:opacity-100 group-hover/g:opacity-100"><Star size={14} fill="currentColor" /></button></div>
                  ))}
                  {gifMode === 'trending' && gifItems.filter((_, i) => i % 2 === col).map((g) => {
                    const on = favByUrl.has(g.url);
                    return <div key={g.id} className="group/g relative"><button className="block w-full overflow-hidden rounded" aria-label={g.title || 'GIF'} onClick={() => pick({ name: g.title ?? 'gif', gif: g.url })}><img src={g.preview || g.url} alt={g.title ?? 'GIF'} loading="lazy" className="w-full" /></button>
                      <button aria-label={on ? t('Remove from favorites') : t('Add to favorites')} aria-pressed={on} onClick={() => toggleFav({ url: g.url, preview: g.preview, title: g.title })} className={cx('absolute end-1 top-1 rounded bg-black/60 p-1 focus:opacity-100 group-hover/g:opacity-100', on ? 'text-warn opacity-100' : 'text-white opacity-0')}><Star size={14} fill={on ? 'currentColor' : 'none'} /></button></div>;
                  })}
                </div>
              ))}
            </div>
            {gifMode === 'trending' && gifs.hasNextPage && <button type="button" className="btn btn-secondary mx-auto mt-2 block" disabled={gifs.isFetchingNextPage} onClick={loadMoreGifs}>{gifs.isFetchingNextPage ? t('Loading…') : t('Load more')}</button>}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {!q && <div className="scroller-hide flex w-10 shrink-0 flex-col items-center gap-1 overflow-y-auto border-e border-divider/50 py-2">
            {rec.length > 0 && <a href="#emo-recent" onClick={(e) => { e.preventDefault(); document.getElementById('emo-recent')?.scrollIntoView(); }} className="rounded p-1 text-interactive hover:bg-hover" aria-label="Recent"><Clock size={18} /></a>}
            {custom.map((g) => <a key={g.guild.id} href={`#emo-${g.guild.id}`} aria-label={g.guild.name} onClick={(e) => { e.preventDefault(); document.getElementById(`emo-${g.guild.id}`)?.scrollIntoView(); }} className="flex h-7 w-7 items-center justify-center rounded-full bg-active text-[10px] font-bold">{g.guild.name[0]}</a>)}
            {EMOJI_CATEGORIES.map((c) => <a key={c.name} href={`#emo-${c.name}`} aria-label={c.name} onClick={(e) => { e.preventDefault(); document.getElementById(`emo-${c.name}`)?.scrollIntoView(); }} className="rounded p-1 text-lg leading-none hover:bg-hover">{c.emojis[0].char}</a>)}
          </div>}
          <div className="scroller min-w-0 flex-1 px-2 pb-2" role="grid">
            {results ? (
              <>
                {customHits.length > 0 && <div className="flex flex-wrap">{customHits.map((e) => <CustomBtn key={e.id} e={e} pick={pick} setHover={setHoverStable} />)}</div>}
                <div className="flex flex-wrap">{results.map((e) => <Btn key={e.name} char={e.char} label={e.name} pick={pick} setHover={setHoverStable} />)}</div>
                {!results.length && !customHits.length && <p className="p-4 text-center text-sm text-muted">No emoji match “{q}”.</p>}
              </>
            ) : (
              <>
                {rec.length > 0 && <Section id="recent" title="Recently used"><div className="flex flex-wrap">{rec.map((c) => <Btn key={c} char={c} label={c} pick={pick} setHover={setHoverStable} />)}</div></Section>}
                {custom.map((g) => <Section key={g.guild.id} id={g.guild.id} title={g.guild.name}><div className="flex flex-wrap">{g.emojis.map((e) => <CustomBtn key={e.id} e={e} pick={pick} setHover={setHoverStable} />)}</div></Section>)}
                {EMOJI_CATEGORIES.map((c) => <Section key={c.name} id={c.name} title={c.name}><div className="flex flex-wrap">{c.emojis.map((e) => <Btn key={e.name} char={e.char} label={e.name} pick={pick} setHover={setHoverStable} />)}</div></Section>)}
              </>
            )}
          </div>
        </div>
      )}
      {tab === 'emoji' && <div className="flex h-9 items-center border-t border-divider/50 px-3 text-sm font-semibold text-header">{hover ? (hover.length < 3 ? hover : `:${hover}:`) : <span className="text-muted">Pick an emoji</span>}</div>}
      {void guildId}
    </div>
  );
}
function StickerGrid({ guildId, q, onPick }: { guildId?: string; q: string; onPick: (s: { id: string; name: string }) => void }) {
  const stickers = useData((s) => (guildId ? s.guilds[guildId]?.stickers : undefined)) ?? [];
  const list = stickers.filter((s) => s.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="scroller min-h-0 flex-1 p-2" role="grid" aria-label={t('Stickers')}>
      {!guildId && <p className="p-4 text-center text-sm text-muted">{t('Stickers can be sent in servers.')}</p>}
      {guildId && !stickers.length && <p className="p-4 text-center text-sm text-muted">{t('This server has no stickers yet. Add some in Server Settings.')}</p>}
      <div className="grid grid-cols-3 gap-2">{list.map((s) => <button key={s.id} role="gridcell" aria-label={s.name} title={s.name} onClick={() => onPick(s)} className="flex aspect-square items-center justify-center rounded-lg p-1 hover:bg-hover"><img src={fileUrl(s.url) ?? s.url} alt={s.name} className="max-h-full max-w-full object-contain" loading="lazy" /></button>)}</div>
    </div>
  );
}
const Btn = memo(function Btn({ char, label, pick, setHover }: { char: string; label: string; pick: (e: EmojiPick) => void; setHover: (s: string) => void }) {
  return <button role="gridcell" aria-label={label} onMouseEnter={() => setHover(label)} onFocus={() => setHover(label)} onClick={() => pick({ char, name: label })} className="flex h-9 w-9 items-center justify-center rounded text-[26px] leading-none hover:bg-hover">{char}</button>;
});
function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return <section id={`emo-${id}`}><h3 className="sticky top-0 z-10 bg-float py-1.5 text-xs font-bold uppercase tracking-wide text-muted">{title}</h3>{children}</section>;
}
function CustomBtn({ e, pick, setHover }: { e: { id: string; name: string; url: string; animated: boolean }; pick: (e: EmojiPick) => void; setHover: (s: string) => void }) {
  return <button role="gridcell" aria-label={e.name} onMouseEnter={() => setHover(e.name)} onClick={() => pick({ name: e.name, id: e.id, animated: e.animated })} className="flex h-9 w-9 items-center justify-center rounded hover:bg-hover"><img src={fileUrl(e.url) ?? e.url} alt={e.name} className="h-7 w-7 object-contain" loading="lazy" /></button>;
}
