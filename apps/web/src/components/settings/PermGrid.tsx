import { useMemo, useState } from 'react';
import { Check, Minus, Search, X } from 'lucide-react';
import { PERMISSION_META, hasPermBit, overwriteState, togglePerm, setOverwriteState, type OverwriteState } from '@/lib/perms';
import { Toggle } from '@/components/ui/primitives';
import { cx } from '@/lib/format';
import type { PermName } from '@jorcord/shared';
import { t } from '@/i18n';

export function PermGrid({ bits, onChange, disabledPerms = [] }: { bits: string; onChange: (b: string) => void; disabledPerms?: PermName[] }) {
  const [q, setQ] = useState('');
  const groups = useMemo(() => { const g: Record<string, typeof PERMISSION_META> = {}; for (const p of PERMISSION_META) if (!q || p.label.toLowerCase().includes(q.toLowerCase())) (g[p.group] ??= []).push(p); return g; }, [q]);
  return (
    <div>
      <div className="mb-4 flex items-center rounded bg-rail px-2"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search permissions')} aria-label={t('Search permissions')} className="h-9 flex-1 bg-transparent text-sm outline-none placeholder:text-muted" /><Search size={16} className="text-muted" /></div>
      {Object.entries(groups).map(([g, ps]) => (
        <section key={g} className="mb-6" aria-label={`${g} permissions`}>
          <h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-interactive">{g} Permissions</h3>
          {ps.map((p) => (
            <div key={p.name} className="flex items-center justify-between gap-4 border-b border-divider/60 py-3">
              <div className="min-w-0"><div className={cx('font-medium', p.name === 'ADMINISTRATOR' ? 'text-danger' : 'text-header')}>{p.label}</div><div className="text-sm text-muted">{p.desc}</div></div>
              <Toggle label={p.label} checked={hasPermBit(bits, p.name)} disabled={disabledPerms.includes(p.name)} onChange={(v) => onChange(togglePerm(bits, p.name, v))} />
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

export function OverwriteGrid({ ow, onChange }: { ow: { allow: string; deny: string }; onChange: (v: { allow: string; deny: string }) => void }) {
  const [q, setQ] = useState('');
  const groups = useMemo(() => { const g: Record<string, typeof PERMISSION_META> = {}; for (const p of PERMISSION_META) if (p.name !== 'ADMINISTRATOR' && p.name !== 'MANAGE_GUILD' && p.name !== 'KICK_MEMBERS' && p.name !== 'BAN_MEMBERS' && (!q || p.label.toLowerCase().includes(q.toLowerCase()))) (g[p.group] ??= []).push(p); return g; }, [q]);
  const set = (n: PermName, s: OverwriteState) => onChange(setOverwriteState(ow, n, s));
  const Btn = ({ n, s, cur }: { n: PermName; s: OverwriteState; cur: OverwriteState }) => (
    <button role="radio" aria-checked={cur === s} aria-label={`${s} ${n}`} onClick={() => set(n, s)} className={cx('flex h-8 w-8 items-center justify-center first:rounded-s last:rounded-e', cur === s ? (s === 'allow' ? 'bg-success text-white' : s === 'deny' ? 'bg-danger text-white' : 'bg-[rgb(var(--muted)/0.5)] text-white') : 'bg-rail text-muted hover:text-header')}>
      {s === 'allow' ? <Check size={16} /> : s === 'deny' ? <X size={16} /> : <Minus size={16} />}
    </button>
  );
  return (
    <div>
      <div className="mb-4 flex items-center rounded bg-rail px-2"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search permissions')} aria-label={t('Search permissions')} className="h-9 flex-1 bg-transparent text-sm outline-none placeholder:text-muted" /><Search size={16} className="text-muted" /></div>
      {Object.entries(groups).map(([g, ps]) => (
        <section key={g} className="mb-6"><h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-interactive">{g} Permissions</h3>
          {ps.map((p) => { const cur = overwriteState(ow, p.name); return (
            <div key={p.name} className="flex items-center justify-between gap-4 border-b border-divider/60 py-3">
              <div className="min-w-0"><div className="font-medium text-header">{p.label}</div><div className="text-sm text-muted">{p.desc}</div></div>
              <div role="radiogroup" aria-label={p.label} className="flex shrink-0"><Btn n={p.name} s="deny" cur={cur} /><Btn n={p.name} s="inherit" cur={cur} /><Btn n={p.name} s="allow" cur={cur} /></div>
            </div>); })}
        </section>
      ))}
    </div>
  );
}
