import { useState } from 'react';
import type { SelfUser } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { toast, toastError } from '@/stores/ui';
import { H1, SaveBar } from './SettingsLayout';
import { Field } from '@/components/ui/primitives';
import { IconPicker } from '@/components/modals/ModalHost';
import { Film } from 'lucide-react';
import { pickProfileGif } from '@/lib/profileGif';
import { Avatar } from '@/components/ui/Avatar';
import { Markdown } from '@/components/chat/Markdown';
import { displayName, fileUrl, idColor } from '@/lib/format';
import { headerBackground } from '@/lib/profileTheme';
import { memberProfile } from '@/lib/memberProfile';
import { t } from '@/i18n';

/** Pick which server's profile to edit; the editor is remounted (keyed) so its form resets on switch. */
export function ServerProfiles() {
  const order = useData((s) => s.guildOrder); const guilds = useData((s) => s.guilds);
  const [guildId, setGuildId] = useState(order[0] ?? '');
  if (!order.length) return (<><H1>{t('Profiles')}</H1><p className="text-sm text-muted">{t('Join a server to set up a name, avatar and bio just for that server.')}</p></>);
  const active = order.includes(guildId) ? guildId : order[0]!;
  return (<>
    <H1>{t('Profiles')}</H1>
    <p className="mb-4 text-sm text-muted">{t('Give each server its own name, avatar, banner, About Me and pronouns. Anything you leave blank falls back to your main profile.')}</p>
    <div className="mb-6">
      <label htmlFor="server-profile-guild" className="label">{t('Server')}</label>
      <select id="server-profile-guild" data-testid="server-profile-guild" className="field" value={active} onChange={(e) => setGuildId(e.target.value)}>
        {order.map((id) => <option key={id} value={id}>{guilds[id]?.guild.name ?? id}</option>)}
      </select>
    </div>
    <ServerProfileEditor key={active} guildId={active} />
  </>);
}

export function ServerProfileEditor({ guildId }: { guildId: string }) {
  const me = useData((s) => s.me)!;
  const member = useData((s) => s.guilds[guildId]?.members[me.id]);
  const guild = useData((s) => s.guilds[guildId]?.guild);
  const init = { nick: member?.nick ?? '', pronouns: member?.pronouns ?? '', bio: member?.bio ?? '', avatar: member?.avatar ?? null, banner: member?.banner ?? null };
  const [f, setF] = useState(init); const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(f) !== JSON.stringify(init);
  /** Send only what actually changed, so an unedited nickname never trips the nickname permission. */
  const save = async () => {
    const body: Record<string, string | null> = {};
    if (f.nick !== (member?.nick ?? '')) body.nick = f.nick || null;
    if (f.pronouns !== (member?.pronouns ?? '')) body.pronouns = f.pronouns || null;
    if (f.bio !== (member?.bio ?? '')) body.bio = f.bio || null;
    if ((f.avatar ?? null) !== (member?.avatar ?? null)) body.avatar = f.avatar;
    if ((f.banner ?? null) !== (member?.banner ?? null)) body.banner = f.banner;
    if (!Object.keys(body).length) return;
    setBusy(true);
    try { const m = await api.guilds.patchMember(guildId, '@me', body); useData.getState().apply('MEMBER_UPDATE', m); toast(t('Server profile saved'), 'success'); }
    catch (e) { toastError(e); }
    setBusy(false);
  };
  const prof = memberProfile(me, { avatar: f.avatar, banner: f.banner, bio: f.bio, pronouns: f.pronouns });
  return (<>
    <div className="flex flex-col gap-8 lg:flex-row"><div className="min-w-0 flex-1">
      <Field label={t('Server Nickname')} hint={guild ? t('Only shown in {server}.', { server: guild.name }) : undefined}><input className="field" value={f.nick} maxLength={32} onChange={(e) => setF({ ...f, nick: e.target.value })} placeholder={me.displayName || me.username} /></Field>
      <Field label={t('Pronouns')}><input className="field" value={f.pronouns} maxLength={40} onChange={(e) => setF({ ...f, pronouns: e.target.value })} placeholder={t('Add your pronouns')} /></Field>
      <div className="mb-4"><span className="label">{t('Avatar')}</span><div className="flex flex-wrap items-center gap-2"><IconPicker value={f.avatar} onChange={(v) => setF({ ...f, avatar: v })} size={72} label={t('Avatar')} /><button type="button" className="btn btn-secondary" onClick={() => pickProfileGif('avatar', (u) => setF((x) => ({ ...x, avatar: u })))}><Film size={16} />{t('Choose GIF')}</button></div></div>
      <BannerField value={f.banner} onChange={(v) => setF((x) => ({ ...x, banner: v }))} />
      <Field label={t('About Me')} hint={t('You can use markdown and links.')}><textarea className="field min-h-[110px]" value={f.bio} maxLength={190} onChange={(e) => setF({ ...f, bio: e.target.value })} /></Field>
    </div>
    <div className="lg:w-[300px]"><span className="label">{t('Preview')}</span><div className="pointer-events-none"><ServerProfilePreview me={me} name={displayName(me, { nick: f.nick || null })} prof={prof} /></div></div></div>
    <SaveBar dirty={dirty} busy={busy} onSave={save} onReset={() => setF(init)} />
  </>);
}

function BannerField({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  return (
    <div className="mb-4">
      <span className="label">{t('Banner')}</span>
      <div className="relative h-24 overflow-hidden rounded-lg" style={{ background: value ? `center/cover url(${fileUrl(value)})` : 'rgb(var(--rail))' }}>
        <label className="absolute inset-0 flex cursor-pointer items-center justify-center bg-black/40 text-sm font-semibold text-white opacity-0 hover:opacity-100 focus-within:opacity-100">
          {t('Change banner')}
          <input type="file" accept="image/*" className="sr-only" onChange={async (e) => { const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; try { onChange(await api.files.uploadImage(file)); } catch (err) { toastError(err); } }} />
        </label>
      </div>
      <div className="mt-1 flex min-h-5 items-center gap-3"><button type="button" className="btn btn-secondary" onClick={() => pickProfileGif('banner', onChange)}><Film size={16} />{t('Choose GIF')}</button>{value && <button type="button" className="text-sm text-link hover:underline" onClick={() => onChange(null)}>{t('Remove banner')}</button>}</div>
    </div>
  );
}

/** Mirrors how ProfileCard renders the resolved (member-over-user) fields. */
function ServerProfilePreview({ me, name, prof }: { me: SelfUser; name: string; prof: ReturnType<typeof memberProfile> }) {
  const banner = prof.banner ? fileUrl(prof.banner) : null;
  return (
    <div className="overflow-hidden rounded-lg bg-[rgb(var(--modal-alt))]">
      <div className="h-[60px]" data-testid="server-preview-banner" style={{ background: headerBackground({ banner: prof.banner, themeColors: me.themeColors, accentColor: me.accentColor }, banner, me.accentColor ?? idColor(me.id)) }} />
      <div className="px-4 pb-4">
        <div className="-mt-10 mb-2 w-fit rounded-full border-[6px] border-[rgb(var(--modal-alt))]"><Avatar user={me} memberAvatar={prof.avatar} size={80} decoration={me.avatarDecoration} /></div>
        <div className="rounded-lg bg-[rgb(var(--rail)/0.5)] p-3">
          <div className="text-xl font-bold text-header" data-testid="server-preview-name">{name}</div>
          <div className="text-sm">{me.username}{prof.pronouns && <span className="text-muted"> • {prof.pronouns}</span>}</div>
          {prof.bio && <><hr className="my-3 border-divider" /><div className="text-xs font-bold uppercase text-header">{t('About Me')}</div><div className="text-sm"><Markdown content={prof.bio} /></div></>}
        </div>
      </div>
    </div>
  );
}
