import { useMemo, useState } from 'react';
import { Perm, WELCOME_SCREEN_MAX_CHANNELS } from '@jorcord/shared';
import type { WelcomeScreenChannel } from '@jorcord/shared';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { toast, toastError } from '@/stores/ui';
import { Field, Row, Toggle } from '@/components/ui/primitives';
import { toBig, toOverwrites, everyoneRole } from '@/lib/perms';
import { computePermissions, has } from '@jorcord/shared';
import { H1, SaveBar } from './SettingsLayout';
import { t } from '@/i18n';

/** Server Settings > Welcome Screen (community servers): up to five channels with a short description each, shown to people who just joined. */
export function WelcomeScreenTab({ guildId }: { guildId: string }) {
  const g = useData((s) => s.guilds[guildId])!;
  const init = useMemo(() => ({ enabled: g.guild.welcomeScreen?.enabled ?? false, description: g.guild.welcomeScreen?.description ?? '', channels: g.guild.welcomeScreen?.channels ?? [] as WelcomeScreenChannel[] }), [g.guild.welcomeScreen]);
  const [f, setF] = useState(init); const [busy, setBusy] = useState(false);
  const everyone = everyoneRole(Object.values(g.roles), guildId);
  // only channels @everyone can see may be advertised (the server enforces the same)
  const choices = useMemo(() => Object.values(g.channels).filter((c) => c.type !== 'category' && c.type !== 'thread' && has(
    computePermissions({ isOwner: false, everyoneRoleId: guildId, everyonePerms: toBig(everyone?.permissions), memberRoleIds: [], rolePerms: {}, memberId: '', overwrites: toOverwrites(c.overwrites) }), Perm.VIEW_CHANNEL)).sort((a, b) => a.position - b.position), [g.channels, everyone, guildId]);
  const used = new Set(f.channels.map((c) => c.channelId));
  const free = choices.filter((c) => !used.has(c.id));
  const dirty = JSON.stringify(f) !== JSON.stringify(init);
  const save = async () => {
    setBusy(true);
    try {
      const w = await api.guilds.patchWelcomeScreen(guildId, { enabled: f.enabled, description: f.description.trim() || null, channels: f.channels.map((c) => ({ channelId: c.channelId, description: c.description.trim(), emoji: c.emoji || null })) });
      useData.getState().apply('GUILD_UPDATE', { ...g.guild, welcomeScreen: w }); toast(t('Welcome screen saved'), 'success');
    } catch (e) { toastError(e); }
    setBusy(false);
  };
  const set = (i: number, patch: Partial<WelcomeScreenChannel>) => setF({ ...f, channels: f.channels.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  return (<>
    <H1>{t('Welcome Screen')}</H1>
    <p className="mb-4 text-sm text-muted">{t('Greet new members and point them to the channels where things happen. Only channels everyone can see can be listed.')}</p>
    <Row title={t('Show a welcome screen to new members')}><Toggle label={t('Show a welcome screen to new members')} checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} /></Row>
    <Field label={t('Server description')} hint={t('Shown at the top of the welcome screen.')}><textarea className="field min-h-[72px]" maxLength={300} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
    <h3 className="section-title mb-2 mt-4">{t('Recommended channels ({n}/{max})', { n: f.channels.length, max: WELCOME_SCREEN_MAX_CHANNELS })}</h3>
    <ul className="space-y-2" aria-label={t('Recommended channels')}>
      {f.channels.map((c, i) => {
        const ch = g.channels[c.channelId];
        return (<li key={c.channelId} className="flex flex-wrap items-center gap-2 rounded-lg bg-modal-alt p-2">
          <input className="field !w-16 text-center" aria-label={t('Emoji')} maxLength={8} placeholder="#" value={c.emoji ?? ''} onChange={(e) => set(i, { emoji: e.target.value || null })} />
          <span className="min-w-[8rem] font-semibold text-header">{ch ? `#${ch.name}` : t('Deleted channel')}</span>
          <input className="field min-w-[10rem] flex-1" aria-label={t('Description for {name}', { name: ch?.name ?? '' })} maxLength={50} value={c.description} placeholder={t('What happens here?')} onChange={(e) => set(i, { description: e.target.value })} />
          <button type="button" aria-label={t('Remove channel')} className="rounded p-1.5 text-danger hover:bg-hover" onClick={() => setF({ ...f, channels: f.channels.filter((_, j) => j !== i) })}><Trash2 size={16} /></button>
        </li>);
      })}
    </ul>
    {f.channels.length < WELCOME_SCREEN_MAX_CHANNELS && free.length > 0 && (
      <label className="mt-3 flex items-center gap-2 text-sm"><Plus size={16} aria-hidden />
        <select className="field !w-auto" aria-label={t('Add a channel')} value="" onChange={(e) => { if (e.target.value) setF({ ...f, channels: [...f.channels, { channelId: e.target.value, description: '', emoji: null }] }); }}>
          <option value="">{t('Add a channel')}</option>{free.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
        </select></label>)}
    <SaveBar dirty={dirty && (!f.enabled || (f.channels.length > 0 && f.channels.every((c) => c.description.trim())))} busy={busy} onSave={save} onReset={() => setF(init)} />
  </>);
}
