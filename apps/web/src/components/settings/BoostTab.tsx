import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Rocket, Check, Sparkles } from 'lucide-react';
import { BOOST_LEVELS } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { toast, toastError } from '@/stores/ui';
import { H1 } from './SettingsLayout';
import { Row, Spinner, Toggle } from '@/components/ui/primitives';
import { Avatar } from '@/components/ui/Avatar';
import { levelGain, levelProgress, perkRows } from '@/lib/boosts';
import { displayName, cx, fmtStamp } from '@/lib/format';
import { t } from '@/i18n';

/** Server Settings > Server Boost: level, progress, perks of each level, the people boosting, and (for managers) announcement + booster role switches. */
export function BoostTab({ guildId, canManage }: { guildId: string; canManage: boolean }) {
  const qc = useQueryClient(); const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ['boosts', guildId], queryFn: () => api.guilds.boosts(guildId) });
  const s = q.data; if (!s) return <><H1>{t('Server Boost')}</H1><Spinner /></>;
  const act = async (p: Promise<unknown>, ok?: string) => { setBusy(true); try { await p; await qc.invalidateQueries({ queryKey: ['boosts', guildId] }); if (ok) toast(ok, 'success'); } catch (e) { toastError(e); } setBusy(false); };
  const pct = levelProgress(s);
  return (<div data-testid="boost-tab">
    <H1>{t('Server Boost')}</H1>
    <div className="mb-6 overflow-hidden rounded-xl bg-gradient-to-br from-brand to-[#eb459e] p-6 text-white">
      <div className="flex items-center gap-3"><Rocket size={36} /><div><div className="text-2xl font-extrabold" data-testid="boost-level">{t('Level')} {s.level}</div><div className="text-sm opacity-90">{s.count} {s.count === 1 ? t('boost') : t('boosts')} • {t('Boosting is always free and unlimited on Jorcord')}</div></div></div>
      <div className="mt-4">
        <div className="mb-1 flex justify-between text-xs font-semibold"><span>{s.nextLevel ? `${s.count} / ${s.nextLevel.boosts} ${t('for Level')} ${s.nextLevel.level}` : t('Max level reached')}</span><span>{pct}%</span></div>
        <div role="progressbar" aria-label={t('Boost progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-2 overflow-hidden rounded-full bg-black/30"><div className="h-full bg-white transition-all" style={{ width: `${pct}%` }} /></div>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button disabled={busy} onClick={() => void act(api.guilds.boost(guildId).then((u) => useData.getState().apply('GUILD_UPDATE', u)), t('Thanks for boosting!'))} className="btn btn-lg bg-white font-bold text-brand hover:bg-white/90">{s.myBoosts ? t('Boost Again') : t('Boost This Server')}</button>
        {s.myBoosts > 0 && <button disabled={busy} onClick={() => void act(api.guilds.unboost(guildId))} className="btn btn-lg bg-black/25 font-semibold text-white hover:bg-black/40">{t('Remove one of my boosts')} ({s.myBoosts})</button>}
      </div>
    </div>
    <div className="mb-8 grid gap-3 md:grid-cols-3" data-testid="boost-levels">{BOOST_LEVELS.slice(1).map((l) => (
      <section key={l.level} aria-label={`${t('Level')} ${l.level}`} className={cx('rounded-lg border p-4', s.level >= l.level ? 'border-brand bg-brand/10' : 'border-divider bg-side')}>
        <h3 className="mb-1 flex items-center justify-between font-bold text-header"><span>{t('Level')} {l.level}</span><span className="text-xs font-normal text-muted">{l.boosts} {t('boosts')}{s.level >= l.level ? ` • ${t('Unlocked')}` : ''}</span></h3>
        <ul className="mb-2 space-y-1 text-sm">{levelGain(l.level as 1 | 2 | 3).map((g) => <li key={g} className="flex gap-2 text-header"><Sparkles size={14} className="mt-1 shrink-0 text-brand" />{g}</li>)}</ul>
        <ul className="space-y-1 text-sm text-muted">{perkRows(l).filter((r) => !r.gated).map((r) => <li key={r.id} className="flex gap-2"><Check size={14} className="mt-1 shrink-0 text-success" />{t(r.label)}: {r.value}</li>)}</ul>
      </section>))}
    </div>
    <p className="mb-8 -mt-5 text-xs text-muted">{t('Every server already has the unlocked-for-everyone perks at every level; levels add emoji and sticker slots and bragging rights.')}</p>
    <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">{t('Boosters')} — {s.boosters.length}</h3>
    {s.boosters.length === 0 ? <p className="mb-6 text-sm text-muted">{t('Nobody is boosting yet.')}</p> :
      <ul className="mb-6" data-testid="boosters">{s.boosters.map((b) => <li key={b.user.id} className="flex items-center gap-3 border-b border-divider/50 py-2"><Avatar user={b.user} size={32} /><span className="flex-1 font-medium text-header">{displayName(b.user)}</span><span className="text-xs text-muted">{b.boosts > 1 ? `${b.boosts} ${t('boosts')} • ` : ''}{t('since')} {fmtStamp(new Date(b.since).getTime())}</span></li>)}</ul>}
    {canManage && <div className="rounded-lg bg-side p-4">
      <Row title={t('Announce boosts')} desc={t('Post a message in the system channel when someone boosts, with the new level when one is reached.')}><Toggle label={t('Announce boosts')} checked={s.settings.announce} onChange={(v) => void act(api.guilds.boostSettings(guildId, { announce: v }))} /></Row>
      <Row title={t('Booster role')} desc={t('Give boosters a shown-separately "Server Booster" role. You can recolour or rename it, but it is handed out automatically.')}><Toggle label={t('Booster role')} checked={s.settings.boosterRole} onChange={(v) => void act(api.guilds.boostSettings(guildId, { boosterRole: v }))} /></Row>
    </div>}
  </div>);
}
