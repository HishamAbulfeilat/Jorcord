import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Hash, Search, Users, Volume2 } from 'lucide-react';
import { useData } from '@/stores/data';
import { useUI } from '@/stores/ui';
import { useNav } from '@/lib/nav';
import { Avatar } from '@/components/ui/Avatar';
import { cx, dmName, compareId, initials, fileUrl, displayName } from '@/lib/format';
import { openDmWith } from '@/lib/menus';

interface Item { key: string; label: string; sub?: string; kind: 'channel' | 'voice' | 'dm' | 'guild' | 'user'; go: () => void; user?: any; icon?: string | null }

export function QuickSwitcher() {
  const open = useUI((s) => s.switcher); const setOpen = useUI((s) => s.setSwitcher);
  const [q, setQ] = useState(''); const [idx, setIdx] = useState(0); const nav = useNav(); const ref = useRef<HTMLInputElement>(null);
  const data = useData();
  useEffect(() => { if (open) { setQ(''); setIdx(0); setTimeout(() => ref.current?.focus(), 0); } }, [open]);
  const items = useMemo<Item[]>(() => {
    if (!open) return [];
    const all: Item[] = [];
    for (const gid of data.guildOrder) { const g = data.guilds[gid]; if (!g) continue;
      all.push({ key: 'g' + gid, label: g.guild.name, kind: 'guild', icon: g.guild.icon, go: () => nav.go(gid, useUI.getState().lastChannel[gid]) });
      for (const c of Object.values(g.channels)) if (c.type !== 'category' && c.type !== 'thread') all.push({ key: c.id, label: c.name ?? '', sub: g.guild.name, kind: c.type === 'voice' || c.type === 'stage' ? 'voice' : 'channel', go: () => nav.go(gid, c.id) });
    }
    for (const c of Object.values(data.dms)) { const other = (c.recipients ?? []).find((r) => r.id !== data.me?.id); all.push({ key: c.id, label: dmName(c, data.me?.id), kind: 'dm', user: c.type === 'group_dm' ? undefined : other, go: () => nav.go('@me', c.id) }); }
    for (const r of Object.values(data.relationships)) if (r.type === 'friend' && !Object.values(data.dms).some((d) => d.type === 'dm' && d.recipients?.some((x) => x.id === r.user.id))) all.push({ key: 'u' + r.user.id, label: displayName(r.user), kind: 'user', user: r.user, go: () => openDmWith(r.user.id) });
    let query = q.trim().toLowerCase(); let filter: Item['kind'][] | null = null;
    if (query.startsWith('#')) { filter = ['channel']; query = query.slice(1); } else if (query.startsWith('@')) { filter = ['dm', 'user']; query = query.slice(1); } else if (query.startsWith('*')) { filter = ['guild']; query = query.slice(1); } else if (query.startsWith('!')) { filter = ['voice']; query = query.slice(1); }
    const pool = filter ? all.filter((i) => filter!.includes(i.kind)) : all;
    if (!query) { const recent = pool.filter((i) => i.kind === 'dm' || i.kind === 'channel').sort((a, b) => compareId(chId(data, b.key), chId(data, a.key))); return recent.slice(0, 12); }
    return pool.map((i) => { const l = i.label.toLowerCase(); const s = l === query ? 3 : l.startsWith(query) ? 2 : l.includes(query) ? 1 : (i.sub ?? '').toLowerCase().includes(query) ? 0.5 : 0; return { i, s }; }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 20).map((x) => x.i);
  }, [open, q, data.guilds, data.dms, data.relationships, data.guildOrder]); // eslint-disable-line
  useEffect(() => setIdx(0), [q]);
  if (!open) return null;
  const run = (it?: Item) => { if (!it) return; setOpen(false); it.go(); };
  return createPortal(
    <div className="fixed inset-0 z-[75] flex items-start justify-center bg-black/60 p-4 pt-[12vh]" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div role="dialog" aria-modal="true" aria-label="Quick switcher" className="w-full max-w-[540px] animate-pop overflow-hidden rounded-lg bg-modal shadow-elev">
        <div className="p-4 pb-2"><input ref={ref} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Where would you like to go?" aria-label="Where would you like to go?" role="combobox" aria-expanded aria-controls="qs-list"
          onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(items.length - 1, i + 1)); } else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); } else if (e.key === 'Enter') { e.preventDefault(); run(items[idx]); } else if (e.key === 'Escape') setOpen(false); }}
          className="h-12 w-full rounded bg-rail px-3 text-lg text-header outline-none placeholder:text-muted focus-visible:!outline-none" /></div>
        <ul id="qs-list" role="listbox" className="scroller max-h-[50vh] px-2 pb-2">
          {items.map((it, i) => (
            <li key={it.key} role="option" aria-selected={i === idx}><button onMouseEnter={() => setIdx(i)} onClick={() => run(it)} className={cx('touch flex w-full items-center gap-3 rounded px-2 py-1.5 text-left', i === idx ? 'bg-hover' : '')}>
              {it.user ? <Avatar user={it.user} size={24} /> : it.kind === 'guild' ? <span className="flex h-6 w-6 items-center justify-center overflow-hidden rounded-lg bg-brand text-[10px] font-bold text-white">{it.icon ? <img src={fileUrl(it.icon)!} alt="" /> : initials(it.label)}</span> : it.kind === 'voice' ? <Volume2 size={20} className="text-muted" /> : it.kind === 'dm' ? <Users size={20} className="text-muted" /> : <Hash size={20} className="text-muted" />}
              <span className="font-medium text-header">{it.label}</span>{it.sub && <span className="text-sm text-muted">{it.sub}</span>}
            </button></li>))}
          {!items.length && <li className="p-6 text-center text-muted">No results match your search.</li>}
        </ul>
        <div className="flex items-center gap-1 border-t border-divider px-4 py-2 text-xs text-muted"><Search size={12} /> <b className="text-green-500">PROTIP:</b> Start with <kbd>@</kbd> users, <kbd>#</kbd> channels, <kbd>*</kbd> servers, <kbd>!</kbd> voice.</div>
      </div>
    </div>, document.body);
}
const chId = (d: ReturnType<typeof useData.getState>, key: string) => { const c = d.dms[key]; if (c) return c.lastMessageId; for (const g of Object.values(d.guilds)) if (g.channels[key]) return g.channels[key].lastMessageId; return null; };
