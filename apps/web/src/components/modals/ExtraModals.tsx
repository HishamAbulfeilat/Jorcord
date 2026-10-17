import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, Check, Hash, Search, Smile, Sparkles, Users, X } from 'lucide-react';
import type { Channel } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { useUI, toast, toastError, defaultKeybinds } from '@/stores/ui';
import { useLayout } from '@/stores/layout';
import { useNotif, setMuted, mutedNow, DEFAULT_GUILD_NOTIFY } from '@/stores/notif';
import { Modal, Field, Spinner, Toggle, Row } from '@/components/ui/primitives';
import { lazyNamed, Lazy } from '@/lib/lazy';
const EmojiPicker = lazyNamed(() => import('@/components/chat/EmojiPicker'), 'EmojiPicker');
import { Markdown } from '@/components/chat/Markdown';
import { IconPicker } from './ModalHost';
import { ChannelIcon } from '@/components/layout/ChannelSidebar';
import { cx, fileUrl, initials, displayName, fmtStamp, msgTime } from '@/lib/format';
import { useNav } from '@/lib/nav';
import { t, T } from '@/i18n';

/* ------------------------------------------------------------------ custom status */
const CLEAR_AFTER: [string, number | 'today' | null][] = [[T("Don't clear"), null], [T('30 minutes'), 30], [T('1 hour'), 60], [T('4 hours'), 240], [T('Today'), 'today']];
export function clearAtFor(opt: number | 'today' | null, now = new Date()): number | null {
  if (opt === null) return null;
  if (opt === 'today') { const d = new Date(now); d.setHours(23, 59, 59, 999); return d.getTime(); }
  return now.getTime() + opt * 60_000;
}

export function CustomStatusModal({ close }: { close: () => void }) {
  const me = useData((s) => s.me)!;
  const [text, setText] = useState(me.customStatus?.text ?? ''); const [emoji, setEmoji] = useState(me.customStatus?.emoji ?? '');
  const [after, setAfter] = useState(0); const [picker, setPicker] = useState(false); const [busy, setBusy] = useState(false);
  const save = async (clear = false) => {
    setBusy(true);
    try {
      // the server enforces the expiry (customStatus.expiresAt): it clears the status and broadcasts PRESENCE_UPDATE
      const at = clearAtFor(CLEAR_AFTER[after]![1]);
      const cs = !clear && (text.trim() || emoji) ? { text: text.trim() || null, emoji: emoji || null, expiresAt: at ? new Date(at).toISOString() : null } : null;
      const u = await api.users.patchMe({ customStatus: cs });
      useData.getState().apply('USER_UPDATE', { ...me, ...u, customStatus: cs });
      useData.getState().apply('PRESENCE_UPDATE', { userId: me.id, presence: useData.getState().presences[me.id] ?? 'online', customStatus: cs } as any);
      close();
    } catch (e) { toastError(e); setBusy(false); }
  };
  return (
    <Modal title={t('Set a custom status')} onClose={close} footer={<><button className="btn btn-link" onClick={() => void save(true)} disabled={busy}>{t('Clear Status')}</button><button className="btn btn-primary btn-lg sm:ms-auto" disabled={busy || (!text.trim() && !emoji)} onClick={() => void save()}>{t('Save')}</button></>}>
      <p className="mb-4 text-center text-sm text-muted">{t('What\'s cookin\', good lookin\'?')}</p>
      <label className="label" htmlFor="cs-text">{t('Status')}</label>
      <div className="relative mb-4 flex items-center rounded bg-input">
        <button type="button" aria-label={t('Select emoji')} aria-expanded={picker} onClick={() => setPicker((v) => !v)} className="flex h-10 w-11 shrink-0 items-center justify-center text-xl text-interactive hover:text-header">{emoji || <Smile size={22} />}</button>
        <input id="cs-text" className="h-10 min-w-0 flex-1 bg-transparent px-1 text-normal outline-none placeholder:text-muted" value={text} maxLength={128} onChange={(e) => setText(e.target.value)} placeholder={t('Support has arrived!')} autoFocus />
        {(text || emoji) && <button type="button" aria-label={t('Clear')} onClick={() => { setText(''); setEmoji(''); }} className="px-2 text-interactive hover:text-header"><X size={16} /></button>}
        {picker && <div className="absolute start-0 top-11 z-10"><Lazy><EmojiPicker onPick={(e: any) => { if (e.char) setEmoji(e.char); setPicker(false); }} /></Lazy></div>}
      </div>
      {me.customStatus?.expiresAt && <p className="mb-2 text-xs text-muted" data-testid="status-expiry">{t('Clears {time}', { time: fmtStamp(new Date(me.customStatus.expiresAt).getTime()) })}</p>}
      <Field label={t('Clear after')}>
        <select className="field" value={after} onChange={(e) => setAfter(Number(e.target.value))}>{CLEAR_AFTER.map(([l], i) => <option key={l} value={i}>{t(l)}</option>)}</select>
      </Field>
    </Modal>
  );
}

/* ------------------------------------------------------------------ folder settings */
const FOLDER_COLORS = ['#5865f2', '#3ba55d', '#faa61a', '#ed4245', '#eb459e', '#9b59b6', '#1abc9c', '#e67e22', '#747f8d'];
export function FolderModal({ folderId, close }: { folderId: string; close: () => void }) {
  const lay = useLayout(); const f = lay.items().find((i) => i.kind === 'folder' && i.id === folderId);
  const [name, setName] = useState(f && f.kind === 'folder' ? f.folder.name : ''); const [color, setColor] = useState(f && f.kind === 'folder' ? f.folder.color ?? FOLDER_COLORS[0]! : FOLDER_COLORS[0]!);
  if (!f || f.kind !== 'folder') return null;
  return (
    <Modal title={t('Folder Settings')} width={420} onClose={close} footer={<><button className="btn btn-link" onClick={close}>{t('Cancel')}</button><button className="btn btn-primary btn-lg sm:ms-auto" onClick={() => { lay.updateFolder(folderId, { name: name.trim(), color }); close(); }}>{t('Save')}</button></>}>
      <Field label={t('Folder Name')}><input className="field" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} placeholder={t('Folder')} autoFocus /></Field>
      <span className="label">{t('Folder Color')}</span>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('Folder Color')}>{FOLDER_COLORS.map((c) => <button key={c} role="radio" aria-checked={c === color} aria-label={c} onClick={() => setColor(c)} className={cx('flex h-8 w-8 items-center justify-center rounded-full', c === color && 'ring-2 ring-header ring-offset-2 ring-offset-[rgb(var(--modal))]')} style={{ background: c }}>{c === color && <Check size={16} className="text-white" />}</button>)}</div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ notification settings (server + channel) */
const MUTE_FOR: [string, number | null][] = [[T('For 15 Minutes'), 15], [T('For 1 Hour'), 60], [T('For 3 Hours'), 180], [T('For 8 Hours'), 480], [T('For 24 Hours'), 1440], [T('Until I turn it back on'), null]];
export function NotifSettingsModal({ scope, id, close }: { scope: 'guild' | 'channel'; id: string; close: () => void }) {
  const guild = useData((s) => (scope === 'guild' ? s.guilds[id]?.guild : undefined));
  const channel = useData((s) => (scope === 'channel' ? Object.values(s.guilds).map((g) => g.channels[id]).find(Boolean) ?? s.dms[id] : undefined)) as Channel | undefined;
  const gs = useNotif((s) => s.guilds[id]) ?? DEFAULT_GUILD_NOTIFY; const cs = useNotif((s) => s.channels[id]); const notif = useNotif.getState();
  const prefMuted = useUI((s) => (scope === 'guild' ? !!s.prefs.mutedGuilds[id] : !!s.prefs.mutedChannels[id]));
  const row = scope === 'guild' ? gs : cs; const muted = prefMuted || mutedNow(row);
  const title = scope === 'guild' ? guild?.name ?? '' : channel ? (channel.guildId ? `#${channel.name}` : channel.name ?? '') : '';
  const [muteOpt, setMuteOpt] = useState(5);
  const level = gs.level;
  const apply = () => setMuted(scope, id, true, MUTE_FOR[muteOpt]![1] ? new Date(Date.now() + MUTE_FOR[muteOpt]![1]! * 60_000) : null);
  return (
    <Modal title={t('Notification Settings')} onClose={close} footer={<button className="btn btn-primary btn-lg sm:ms-auto" onClick={close}>{t('Done')}</button>}>
      <p className="mb-4 text-center text-sm text-muted">{title}</p>
      <Row title={scope === 'guild' ? t('Mute Server') : t('Mute Channel')} desc={muted ? (row?.mutedUntil ? t('Muted until {time}', { time: fmtStamp(new Date(row.mutedUntil).getTime()) }) : t('Muted')) : t('Muted servers and channels will not notify you.')}>
        <Toggle label={scope === 'guild' ? t('Mute Server') : t('Mute Channel')} checked={muted} onChange={(v) => (v ? apply() : setMuted(scope, id, false))} />
      </Row>
      {!muted && <label className="mt-3 block text-sm"><span className="label">{t('Mute duration')}</span><select aria-label={t('Mute duration')} className="field" value={muteOpt} onChange={(e) => setMuteOpt(Number(e.target.value))}>{MUTE_FOR.map(([l], i) => <option key={l} value={i}>{t(l)}</option>)}</select><span className="mt-1 block text-xs text-muted">{t('Choose how long, then switch the toggle on.')}</span></label>}
      {scope === 'guild' && (<>
        <h3 className="section-title mb-2 mt-5">{t('Server Notification Settings')}</h3>
        <div role="radiogroup" aria-label={t('Server Notification Settings')} className="grid gap-2">
          {([[null, T('Use my default')], ['all', T('All Messages')], ['mentions', T('Only @mentions')], ['none', T('Nothing')]] as const).map(([v, l]) => (
            <label key={String(v)} className={cx('flex cursor-pointer items-center gap-3 rounded-lg border-2 p-3', level === v ? 'border-brand' : 'border-divider')}>
              <input type="radio" name="gl" className="accent-brand" checked={level === v} onChange={() => void notif.setGuild(id, { level: v })} /><span className="font-medium text-header">{t(l)}</span></label>
          ))}
        </div>
        <Row title={t('Suppress @everyone and @here')}><Toggle label={t('Suppress @everyone and @here')} checked={gs.suppressEveryone} onChange={(v) => void notif.setGuild(id, { suppressEveryone: v })} /></Row>
        <Row title={t('Suppress All Role @mentions')}><Toggle label={t('Suppress All Role @mentions')} checked={gs.suppressRoles} onChange={(v) => void notif.setGuild(id, { suppressRoles: v })} /></Row>
      </>)}
    </Modal>
  );
}

/* ------------------------------------------------------------------ welcome + rules screening */
export function OnboardingModal({ guildId, step: initial, close }: { guildId: string; step?: 'welcome' | 'rules'; close: () => void }) {
  const g = useData((s) => s.guilds[guildId]); const nav = useNav(); const mark = useLayout((s) => s.markOnboarded);
  const done = useLayout((s) => !!s.onboarded[guildId]);
  const rulesId = g?.guild.rulesChannelId ?? null;
  const [step, setStep] = useState<'welcome' | 'rules'>(initial ?? 'welcome'); const [agree, setAgree] = useState(done);
  const rules = useQuery({ queryKey: ['rules', rulesId], enabled: !!rulesId && step === 'rules', queryFn: () => api.messages.list(rulesId!, { limit: 30 }), retry: false });
  const picks = useMemo(() => Object.values(g?.channels ?? {}).filter((c) => (c.type === 'text' || c.type === 'announcement' || c.type === 'forum' || c.type === 'media') && c.id !== rulesId).sort((a, b) => a.position - b.position).slice(0, 5), [g?.channels, rulesId]);
  if (!g) return null;
  const gd = g.guild; const icon = fileUrl(gd.icon); const banner = fileUrl(gd.banner);
  const finish = () => { mark(guildId); try { sessionStorage.removeItem('jorcord.onb.' + guildId); } catch { /* */ } close(); if (picks[0]) nav.go(guildId, picks[0].id); };
  const later = () => { try { sessionStorage.setItem('jorcord.onb.' + guildId, '1'); } catch { /* */ } close(); };
  if (step === 'welcome') return (
    <Modal onClose={later} width={480} padded={false} labelledBy="onb-title" footer={<><button className="btn btn-link" onClick={later}>{t('Maybe later')}</button><button className="btn btn-primary btn-lg sm:ms-auto" onClick={() => (rulesId ? setStep('rules') : finish())}>{rulesId ? t('Next') : t('Get Started')}</button></>}>
      <div className="h-24 bg-brand/60" style={banner ? { background: `center/cover url(${banner})` } : undefined} />
      <div className="px-6 pb-6">
        <div className="-mt-10 mb-3 flex h-20 w-20 items-center justify-center overflow-hidden rounded-[24px] border-[6px] border-[rgb(var(--modal))] bg-brand text-2xl font-bold text-white">{icon ? <img src={icon} alt="" className="h-full w-full object-cover" /> : initials(gd.name)}</div>
        <h2 id="onb-title" className="text-2xl font-extrabold text-header">{t('Welcome to {name}', { name: gd.name })}</h2>
        <p className="mt-1 flex items-center gap-1 text-sm text-muted"><Users size={14} />{t('{n} members', { n: g.memberCount })}</p>
        {gd.description && <p className="mt-3 whitespace-pre-wrap text-normal">{gd.description}</p>}
        {picks.length > 0 && (<><h3 className="section-title mb-2 mt-5">{t('Start here')}</h3><ul className="grid gap-1.5">{picks.map((c) => <li key={c.id}><button onClick={() => { nav.go(guildId, c.id); later(); }} className="flex w-full items-center gap-2 rounded-lg bg-modal-alt px-3 py-2 text-start hover:bg-hover"><ChannelIcon c={c} size={20} className="text-muted" /><span className="min-w-0 flex-1"><span className="block truncate font-semibold text-header">{c.name}</span>{c.topic && <span className="block truncate text-xs text-muted">{c.topic}</span>}</span></button></li>)}</ul></>)}
      </div>
    </Modal>
  );
  return (
    <Modal title={t('Review the rules')} onClose={later} width={520} footer={<><button className="btn btn-link" onClick={() => setStep('welcome')}>{t('Back')}</button><label className="flex items-center gap-2 text-sm sm:ms-auto"><input type="checkbox" className="h-5 w-5 accent-brand" checked={agree} onChange={(e) => setAgree(e.target.checked)} />{t('I have read and agree to the rules')}</label><button disabled={!agree} className="btn btn-primary btn-lg" onClick={finish}>{t('Complete')}</button></>}>
      <p className="mb-3 flex items-center gap-2 text-sm text-muted"><BookOpen size={16} />{t('Please read the rules of {name} before you start chatting.', { name: gd.name })}</p>
      {rules.isLoading && <Spinner className="mx-auto my-6" />}
      {rules.isError && <p className="py-4 text-center text-sm text-muted">{t('The rules could not be loaded. Ask a moderator.')}</p>}
      <ol className="space-y-3">{[...(rules.data ?? [])].reverse().map((m) => <li key={m.id} className="rounded-lg bg-modal-alt p-3 text-sm"><Markdown content={m.content} guildId={guildId} /><time className="mt-1 block text-xs text-muted">{fmtStamp(msgTime(m.id, m.createdAt))}</time></li>)}</ol>
      {rules.data && !rules.data.length && <p className="py-4 text-center text-sm text-muted">{t('The rules channel is empty.')}</p>}
    </Modal>
  );
}

/* ------------------------------------------------------------------ keyboard shortcuts */
const kbd = 'rounded bg-rail px-2 py-0.5 font-mono text-xs text-header shadow-[inset_0_-1px_0_rgb(0_0_0/0.3)]';
export function ShortcutsModal({ close }: { close: () => void }) {
  const kb = useUI((s) => s.prefs.keybinds); const openSettings = useUI((s) => s.openSettings); const [q, setQ] = useState('');
  const k = (n: string) => kb[n] ?? defaultKeybinds[n] ?? '';
  const groups: { title: string; rows: [string, string][] }[] = [
    { title: T('Navigation'), rows: [[T('Quick switcher'), k('quickSwitcher')], [T('Previous channel'), k('prevChannel')], [T('Next channel'), k('nextChannel')], [T('Previous server'), k('prevServer')], [T('Next server'), k('nextServer')], [T('Toggle member list'), k('toggleMembers')], [T('Search'), k('search')], [T('Mark channel as read'), k('markRead')], [T('Keyboard shortcuts'), k('shortcuts')]] },
    { title: T('Messaging'), rows: [[T('Send message'), 'Enter'], [T('New line'), 'Shift+Enter'], [T('Edit your last message'), 'ArrowUp'], [T('Cancel reply or edit'), 'Escape'], [T('Mention someone'), '@'], [T('Link a channel'), '#'], [T('Insert emoji'), ':'], [T('Paste an image to upload'), 'Ctrl+V']] },
    { title: T('Voice'), rows: [[T('Toggle mute'), k('toggleMute')], [T('Toggle deafen'), k('toggleDeafen')], [T('Push to talk'), k('pushToTalk')]] },
    { title: T('Text formatting'), rows: [[T('Bold'), '**text**'], [T('Italic'), '*text*'], [T('Underline'), '__text__'], [T('Strikethrough'), '~~text~~'], [T('Spoiler'), '||text||'], [T('Inline code'), '`code`'], [T('Quote'), '> text']] },
  ];
  const f = q.trim().toLowerCase();
  return (
    <Modal title={t('Keyboard Shortcuts')} width={560} onClose={close} footer={<><button className="btn btn-link" onClick={() => { close(); openSettings({ kind: 'user', tab: 'keybinds' }); }}>{t('Customize keybinds')}</button><button className="btn btn-primary btn-lg sm:ms-auto" onClick={close}>{t('Done')}</button></>}>
      <div className="mb-3 flex items-center rounded bg-input px-2"><input aria-label={t('Search shortcuts')} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Search shortcuts')} className="h-9 flex-1 bg-transparent text-sm outline-none placeholder:text-muted" /><Search size={16} className="text-muted" /></div>
      {groups.map((g) => { const rows = g.rows.filter(([l, c]) => !f || t(l).toLowerCase().includes(f) || c.toLowerCase().includes(f)); if (!rows.length) return null; return (
        <section key={g.title} aria-label={t(g.title)} className="mb-4"><h3 className="section-title mb-1">{t(g.title)}</h3>
          <ul>{rows.map(([l, c]) => <li key={l} className="flex items-center justify-between gap-3 border-b border-divider/50 py-2 text-sm"><span>{t(l)}</span><span className="flex flex-wrap justify-end gap-1">{c.split('+').map((p, i) => <kbd key={i} className={kbd}>{p}</kbd>)}</span></li>)}</ul></section>); })}
    </Modal>
  );
}

/* ------------------------------------------------------------------ streamer mode prompt (when Go Live starts) */
export function StreamerStartModal({ close }: { close: () => void }) {
  const set = useUI((s) => s.setPref);
  return (
    <Modal title={t('Streamer Mode')} width={420} onClose={close} footer={<><button className="btn btn-link" onClick={close}>{t('Not now')}</button><button className="btn btn-primary btn-lg sm:ms-auto" onClick={() => { set('streamerMode', true); close(); }}>{t('Enable Streamer Mode')}</button></>}>
      <p className="text-center text-normal"><Sparkles className="mx-auto mb-2 text-brand" />{t('Streamer Mode hides personal information, invite links and notifications while you broadcast.')}</p>
    </Modal>
  );
}
void Hash; void displayName; void useEffect;
