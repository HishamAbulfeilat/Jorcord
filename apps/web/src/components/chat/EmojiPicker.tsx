import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, Smile, Clock, Film } from 'lucide-react';
import { EMOJI_CATEGORIES, searchEmoji } from '@/lib/emoji';
import { useData } from '@/stores/data';
import { api } from '@/lib/api';
import { cx } from '@/lib/format';
import { useDebounced } from '@/lib/hooks';
import { Spinner } from '@/components/ui/primitives';

export type EmojiPick = { char?: string; name: string; id?: string; animated?: boolean; gif?: string };
const RKEY = 'jorcord.recent.emoji';
const recent = (): string[] => { try { return JSON.parse(localStorage.getItem(RKEY) ?? '[]'); } catch { return []; } };
const pushRecent = (c: string) => { try { localStorage.setItem(RKEY, JSON.stringify([c, ...recent().filter((x) => x !== c)].slice(0, 24))); } catch { /* */ } };

export function EmojiPicker({ onPick, guildId, allowGif = false }: { onPick: (e: EmojiPick) => void; guildId?: string; allowGif?: boolean }) {
  const [q, setQ] = useState(''); const [tab, setTab] = useState<'emoji' | 'gif'>('emoji'); const [hover, setHover] = useState<string>('');
  const guilds = useData((s) => s.guilds); const order = useData((s) => s.guildOrder);
  const dq = useDebounced(q, 250);
  const custom = useMemo(() => order.map((id) => guilds[id]).filter((g) => g && g.emojis.length), [guilds, order]);
  const results = q ? searchEmoji(q, 90) : null;
  const customHits = q ? custom.flatMap((g) => g.emojis.filter((e) => e.name.toLowerCase().includes(q.toLowerCase().replace(/^:/, '')))) : [];
  const rec = recent();
  const gifs = useQuery({ queryKey: ['gifs', dq], queryFn: () => api.misc.gifs(dq || undefined), enabled: tab === 'gif', staleTime: 60_000 });
  const pick = (e: EmojiPick) => { if (e.char) pushRecent(e.char); onPick(e); };
  const Btn = ({ char, label }: { char: string; label: string }) => (
    <button role="gridcell" aria-label={label} onMouseEnter={() => setHover(label)} onFocus={() => setHover(label)} onClick={() => pick({ char, name: label })} className="flex h-9 w-9 items-center justify-center rounded text-[26px] leading-none hover:bg-hover">{char}</button>
  );
  return (
    <div className="flex h-[min(420px,70dvh)] w-full flex-col overflow-hidden rounded-lg bg-float text-normal shadow-elev sm:w-[360px]" role="dialog" aria-label="Emoji picker">
      <div className="flex items-center gap-2 p-2">
        <div className="flex flex-1 items-center rounded bg-rail px-2"><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={tab === 'gif' ? 'Search GIFs' : 'Find the perfect emoji'} aria-label="Search" className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted" /><Search size={16} className="text-muted" /></div>
        {allowGif && <div className="flex gap-1">
          <button aria-pressed={tab === 'emoji'} aria-label="Emoji" onClick={() => setTab('emoji')} className={cx('rounded p-1.5', tab === 'emoji' ? 'bg-active text-header' : 'text-interactive')}><Smile size={18} /></button>
          <button aria-pressed={tab === 'gif'} aria-label="GIFs" onClick={() => setTab('gif')} className={cx('rounded p-1.5', tab === 'gif' ? 'bg-active text-header' : 'text-interactive')}><Film size={18} /></button>
        </div>}
      </div>
      {tab === 'gif' ? (
        <div className="scroller min-h-0 flex-1 columns-2 gap-1 p-2">
          {gifs.isLoading && <Spinner className="mx-auto mt-8" />}
          {gifs.data?.length === 0 && <p className="p-4 text-center text-sm text-muted">No GIFs available. The server has no GIF provider configured.</p>}
          {gifs.data?.map((g) => <button key={g.id} className="mb-1 block w-full overflow-hidden rounded" onClick={() => pick({ name: g.title ?? 'gif', gif: g.url })}><img src={g.preview || g.url} alt={g.title ?? 'GIF'} loading="lazy" className="w-full" /></button>)}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {!q && <div className="scroller-hide flex w-10 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-divider/50 py-2">
            {rec.length > 0 && <a href="#emo-recent" onClick={(e) => { e.preventDefault(); document.getElementById('emo-recent')?.scrollIntoView(); }} className="rounded p-1 text-interactive hover:bg-hover" aria-label="Recent"><Clock size={18} /></a>}
            {custom.map((g) => <a key={g.guild.id} href={`#emo-${g.guild.id}`} aria-label={g.guild.name} onClick={(e) => { e.preventDefault(); document.getElementById(`emo-${g.guild.id}`)?.scrollIntoView(); }} className="flex h-7 w-7 items-center justify-center rounded-full bg-active text-[10px] font-bold">{g.guild.name[0]}</a>)}
            {EMOJI_CATEGORIES.map((c) => <a key={c.name} href={`#emo-${c.name}`} aria-label={c.name} onClick={(e) => { e.preventDefault(); document.getElementById(`emo-${c.name}`)?.scrollIntoView(); }} className="rounded p-1 text-lg leading-none hover:bg-hover">{c.emojis[0].char}</a>)}
          </div>}
          <div className="scroller min-w-0 flex-1 px-2 pb-2" role="grid">
            {results ? (
              <>
                {customHits.length > 0 && <div className="flex flex-wrap">{customHits.map((e) => <CustomBtn key={e.id} e={e} pick={pick} setHover={setHover} />)}</div>}
                <div className="flex flex-wrap">{results.map((e) => <Btn key={e.name} char={e.char} label={e.name} />)}</div>
                {!results.length && !customHits.length && <p className="p-4 text-center text-sm text-muted">No emoji match “{q}”.</p>}
              </>
            ) : (
              <>
                {rec.length > 0 && <Section id="recent" title="Recently used"><div className="flex flex-wrap">{rec.map((c) => <Btn key={c} char={c} label={c} />)}</div></Section>}
                {custom.map((g) => <Section key={g.guild.id} id={g.guild.id} title={g.guild.name}><div className="flex flex-wrap">{g.emojis.map((e) => <CustomBtn key={e.id} e={e} pick={pick} setHover={setHover} />)}</div></Section>)}
                {EMOJI_CATEGORIES.map((c) => <Section key={c.name} id={c.name} title={c.name}><div className="flex flex-wrap">{c.emojis.map((e) => <Btn key={e.name} char={e.char} label={e.name} />)}</div></Section>)}
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
function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return <section id={`emo-${id}`}><h3 className="sticky top-0 z-10 bg-float py-1.5 text-xs font-bold uppercase tracking-wide text-muted">{title}</h3>{children}</section>;
}
function CustomBtn({ e, pick, setHover }: { e: { id: string; name: string; url: string; animated: boolean }; pick: (e: EmojiPick) => void; setHover: (s: string) => void }) {
  return <button role="gridcell" aria-label={e.name} onMouseEnter={() => setHover(e.name)} onClick={() => pick({ name: e.name, id: e.id, animated: e.animated })} className="flex h-9 w-9 items-center justify-center rounded hover:bg-hover"><img src={e.url} alt={e.name} className="h-7 w-7 object-contain" loading="lazy" /></button>;
}
