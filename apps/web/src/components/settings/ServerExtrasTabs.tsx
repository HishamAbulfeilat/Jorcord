import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { GuildTemplate, Id } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { toast, toastError } from '@/stores/ui';
import { H1, H3 } from './SettingsLayout';
import { Empty, Field, Row, Spinner, Toggle } from '@/components/ui/primitives';
import { copyText } from '@/lib/format';
import { apiBase, publicOrigin } from '@/lib/server';
import { t } from '@/i18n';

/** Server Settings > Server Template. */
export function TemplateTab({ guildId }: { guildId: Id }) {
  const qc = useQueryClient(); const q = useQuery({ queryKey: ['templates', guildId], queryFn: () => api.guilds.templates(guildId), staleTime: 0 });
  const [name, setName] = useState(''); const [desc, setDesc] = useState(''); const [busy, setBusy] = useState(false);
  const tpl: GuildTemplate | undefined = q.data?.[0];
  const link = (c: string) => `${publicOrigin()}/template/${c}`;
  const run = async (p: Promise<unknown>, ok?: string) => { setBusy(true); try { await p; await qc.invalidateQueries({ queryKey: ['templates', guildId] }); if (ok) toast(ok, 'success'); } catch (e) { toastError(e); } setBusy(false); };
  return (<div data-testid="template-tab">
    <H1>{t('Server Template')}</H1>
    <p className="mb-4 text-sm text-muted">{t('Share your server setup, roles, channels and permissions, as a link. People can start their own server from it. Messages, members and emoji are never copied.')}</p>
    {q.isLoading && <Spinner />}
    {!q.isLoading && !tpl && (<div className="rounded-lg bg-side p-3">
      <Field label={t('Template name')}><input className="field" aria-label={t('Template name')} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label={t('Description')}><input className="field" aria-label={t('Template description')} maxLength={120} value={desc} onChange={(e) => setDesc(e.target.value)} /></Field>
      <button className="btn btn-primary btn-lg" disabled={busy || !name.trim()} onClick={() => void run(api.guilds.createTemplate(guildId, { name: name.trim(), description: desc.trim() || null }), t('Template created'))}>{t('Generate Template Link')}</button>
    </div>)}
    {tpl && (<div className="rounded-lg bg-side p-3">
      <div className="mb-1 text-lg font-bold text-header">{tpl.name}</div>
      {tpl.description && <p className="mb-2 text-sm text-muted">{tpl.description}</p>}
      <div className="mb-3 flex gap-2"><input readOnly aria-label={t('Template link')} className="field flex-1" value={link(tpl.code)} onFocus={(e) => e.currentTarget.select()} /><button className="btn btn-secondary" onClick={() => copyText(link(tpl.code)).then(() => toast(t('Link copied'), 'success'))}>{t('Copy')}</button></div>
      <p className="mb-3 text-sm text-muted">{t('Used {n} times', { n: tpl.usageCount })}</p>
      {tpl.isDirty && <p role="status" data-testid="template-dirty" className="mb-3 rounded bg-warn/20 p-2 text-sm text-header">{t('This server has changed since the template was last synced.')}</p>}
      <div className="flex gap-2"><button className="btn btn-primary" disabled={busy || !tpl.isDirty} onClick={() => void run(api.guilds.syncTemplate(guildId, tpl.code), t('Template synced'))}>{t('Sync Template')}</button><button className="btn btn-danger" disabled={busy} onClick={() => void run(api.guilds.deleteTemplate(guildId, tpl.code), t('Template deleted'))}>{t('Delete Template')}</button></div>
    </div>)}
  </div>);
}

/** Server Settings > Widget. */
export function WidgetTab({ guildId }: { guildId: Id }) {
  const qc = useQueryClient(); const g = useData((s) => s.guilds[guildId])!;
  const q = useQuery({ queryKey: ['widget', guildId], queryFn: () => api.guilds.widget(guildId) });
  const set = (b: Parameters<typeof api.guilds.patchWidget>[1]) => api.guilds.patchWidget(guildId, b).then((w) => qc.setQueryData(['widget', guildId], w)).catch(toastError);
  const api0 = apiBase(); const base = `${api0.startsWith('/') ? publicOrigin() : ''}${api0}/guilds/${guildId}`;
  const w = q.data;
  const chans = Object.values(g.channels).filter((c) => c.type !== 'category' && c.type !== 'thread').sort((a, b) => a.position - b.position);
  return (<div data-testid="widget-tab">
    <H1>{t('Widget')}</H1>
    <p className="mb-4 text-sm text-muted">{t('A public JSON and image summary of your server (online members, voice channels and a join link) for websites. Only what is shown below is exposed.')}</p>
    {!w ? <Spinner /> : (<>
      <Row title={t('Enable server widget')}><Toggle label={t('Enable server widget')} checked={w.enabled} onChange={(v) => void set({ enabled: v })} /></Row>
      <Field label={t('Invite channel')} hint={t('Visitors who click Join land in this channel.')}><select className="field" aria-label={t('Invite channel')} value={w.channelId ?? ''} onChange={(e) => void set({ channelId: e.target.value || null })}><option value="">{t('No invite')}</option>{chans.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}</select></Field>
      {w.enabled && (<>
        <H3>{t('Links')}</H3>
        <div className="space-y-2 text-sm"><div><span className="label">JSON</span><input readOnly className="field" aria-label="Widget JSON URL" value={`${base}/widget.json`} onFocus={(e) => e.currentTarget.select()} /></div>
          <div><span className="label">{t('Image')}</span><input readOnly className="field" aria-label="Widget image URL" value={`${base}/widget.svg`} onFocus={(e) => e.currentTarget.select()} /></div></div>
        <H3>{t('Preview')}</H3><img alt={t('Widget preview')} data-testid="widget-preview" src={`${base}/widget.svg?theme=dark`} className="rounded-lg" width={320} height={96} />
      </>)}
    </>)}
  </div>);
}

/** Server Settings > Insights: joins, leaves and messages over the last days. */
export function InsightsTab({ guildId }: { guildId: Id }) {
  const [days, setDays] = useState<7 | 14 | 30>(7);
  const q = useQuery({ queryKey: ['insights', guildId, days], queryFn: () => api.guilds.insights(guildId, days), staleTime: 15_000 });
  const d = q.data; const max = (xs: number[]) => Math.max(1, ...xs);
  const Bars = ({ label, vals, color }: { label: string; vals: { day: string; v: number }[]; color: string }) => (
    <figure className="mb-4" aria-label={label}><figcaption className="mb-1 text-xs font-bold uppercase text-muted">{label}</figcaption>
      <div className="flex h-24 items-end gap-0.5 rounded bg-side p-2">{vals.map((x) => <div key={x.day} title={`${x.day}: ${x.v}`} className="min-w-[3px] flex-1 rounded-t" style={{ height: `${Math.max(2, (x.v / max(vals.map((y) => y.v))) * 100)}%`, background: color }} />)}</div></figure>
  );
  return (<div data-testid="insights-tab">
    <H1>{t('Server Insights')}</H1>
    <div role="radiogroup" aria-label={t('Period')} className="mb-4 flex gap-2">{([7, 14, 30] as const).map((n) => <button key={n} role="radio" aria-checked={days === n} className={`btn ${days === n ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setDays(n)}>{t('{n} days', { n })}</button>)}</div>
    {q.isLoading && <Spinner />}
    {d && (<>
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[[t('Members'), d.memberCount], [t('Online now'), d.onlineNow], [t('New members'), d.totals.joins], [t('Left'), d.totals.leaves], [t('Messages'), d.totals.messages], [t('Active chatters'), d.totals.activeChatters]].map(([l, v]) => <div key={String(l)} className="rounded-lg bg-side p-3"><div className="text-xs text-muted">{l}</div><div className="text-xl font-bold text-header" data-testid={`insight-${String(l).toLowerCase().replace(/\s+/g, '-')}`}>{v}</div></div>)}
      </div>
      <Bars label={t('New members per day')} vals={d.joins.map((x) => ({ day: x.day, v: x.joins }))} color="rgb(var(--success))" />
      <Bars label={t('Messages per day')} vals={d.messages.map((x) => ({ day: x.day, v: x.count }))} color="rgb(var(--brand))" />
      <H3>{t('Top channels')}</H3>
      {!d.topChannels.length && <Empty title={t('No activity yet')} />}
      <ol className="space-y-1">{d.topChannels.map((c) => <li key={c.channelId} className="flex justify-between rounded bg-side px-3 py-2 text-sm text-header"><span># {c.name}</span><span className="text-muted">{c.count}</span></li>)}</ol>
    </>)}
  </div>);
}

/** Server Settings > Overview: claim a custom invite link (free for every server). */
export function VanityUrl({ guildId }: { guildId: Id }) {
  const gd = useData((s) => s.guilds[guildId])!.guild; const [v, setV] = useState(gd.vanityUrl ?? ''); const [busy, setBusy] = useState(false);
  const valid = v === '' || /^[a-z0-9-]{3,32}$/.test(v);
  const save = async () => { setBusy(true); try { const u = await api.guilds.patch(guildId, { vanityUrl: v || null } as any); useData.getState().apply('GUILD_UPDATE', { ...gd, ...u }); toast(v ? t('Custom invite link claimed') : t('Custom invite link removed'), 'success'); } catch (e) { toastError(e); } setBusy(false); };
  return (
    <div className="mb-4" data-testid="vanity-url">
      <span className="label">{t('Custom Invite Link')}</span>
      <p className="mb-2 text-xs text-muted">{t('Claim a short, memorable invite link. Letters, digits and dashes, 3 to 32 characters.')}</p>
      <div className="flex items-center gap-2"><span className="text-sm text-muted">{publicOrigin().replace(/^https?:\/\//, '')}/invite/</span><input className="field !w-48" aria-label={t('Custom invite link')} value={v} maxLength={32} onChange={(e) => setV(e.target.value.toLowerCase())} placeholder="my-server" />
        <button className="btn btn-secondary" disabled={busy || !valid || v === (gd.vanityUrl ?? '')} onClick={() => void save()}>{v ? t('Claim') : t('Remove')}</button></div>
      {!valid && <p className="mt-1 text-sm text-danger">{t('Use 3 to 32 lowercase letters, digits or dashes.')}</p>}
    </div>
  );
}
