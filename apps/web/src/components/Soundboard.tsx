import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AudioLines, Play, Trash2, Upload, Volume2, VolumeX } from 'lucide-react';
import { LIMITS, Perm, type Id, type SoundboardSound } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useUI, toast, toastError } from '@/stores/ui';
import { useData } from '@/stores/data';
import { H1 } from '@/components/settings/SettingsLayout';
import { Empty, Spinner } from '@/components/ui/primitives';
import { Tip } from '@/components/ui/Tooltip';
import { useGuildPerms } from '@/lib/useGuild';
import { can } from '@/lib/perms';
import { cx } from '@/lib/format';
import { playClip } from '@/lib/soundboard';
import { t } from '@/i18n';

const useSounds = (guildId: Id) => useQuery({ queryKey: ['sounds', guildId], queryFn: () => api.guilds.sounds(guildId) });

/** Voice dock button + popover: play a clip into the call. Also holds the local "mute soundboard" switch and volume. */
export function SoundboardButton({ channelId, guildId }: { channelId: Id; guildId: Id }) {
  const [open, setOpen] = useState(false); const ref = useRef<HTMLDivElement>(null);
  const q = useSounds(guildId); const prefs = useUI((s) => s.prefs); const setPref = useUI((s) => s.setPref);
  const perms = useGuildPerms(guildId); const allowed = can(perms, Perm.USE_SOUNDBOARD);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', h); document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [open]);
  const play = (s: SoundboardSound) => api.guilds.playSound(channelId, s.id).catch(toastError);
  return (
    <div ref={ref} className="relative contents">
      <Tip text={t('Soundboard')} side="top">
        <button aria-label={t('Soundboard')} aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="dock-soundboard" className={cx('flex h-8 w-full items-center justify-center rounded text-header', open ? '!bg-white !text-black' : 'bg-[rgb(var(--active))] hover:bg-[rgb(var(--divider))]')}><AudioLines size={18} /></button>
      </Tip>
      {open && (
        <div role="dialog" aria-label={t('Soundboard')} data-testid="soundboard-popover" className="absolute inset-x-0 bottom-full z-50 mb-2 animate-pop rounded-lg bg-float p-3 text-start shadow-elev">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wide text-interactive">{t('Soundboard')}</span>
            <button aria-pressed={prefs.soundboardMuted} aria-label={prefs.soundboardMuted ? t('Unmute soundboard') : t('Mute soundboard')} onClick={() => setPref('soundboardMuted', !prefs.soundboardMuted)} className="rounded p-1 text-interactive hover:bg-hover">{prefs.soundboardMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}</button>
          </div>
          <label className="mb-2 flex items-center gap-2 text-xs text-muted">{t('Volume')}<input type="range" min={0} max={100} value={prefs.soundboardVolume} aria-label={t('Soundboard volume')} onChange={(e) => setPref('soundboardVolume', Number(e.target.value))} className="flex-1 accent-brand" /></label>
          <EffectRow channelId={channelId} guildId={guildId} />
          {q.isLoading && <Spinner />}
          {!allowed && <p className="text-sm text-muted">{t('You do not have permission to use the soundboard.')}</p>}
          {allowed && !q.isLoading && !q.data?.length && <p className="text-sm text-muted">{t('This server has no sounds yet.')}</p>}
          <ul className="grid max-h-56 grid-cols-2 gap-1.5 overflow-auto">
            {allowed && q.data?.map((s) => (
              <li key={s.id}><button onClick={() => play(s)} aria-label={`${t('Play')} ${s.name}`} className="flex w-full items-center gap-2 rounded bg-[rgb(var(--active))] px-2 py-2 text-sm text-header hover:bg-[rgb(var(--divider))]"><span aria-hidden>{s.emoji || '🔊'}</span><span className="truncate">{s.name}</span></button></li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Quick emoji bursts shown floating over your tile for everybody in the call (rate limited by the server to one per 3 seconds). */
export const EFFECT_EMOJIS = ['👏', '❤️', '😂', '🔥', '🎉', '👍', '😮', '😢'] as const;
function EffectRow({ channelId, guildId }: { channelId: Id; guildId: Id }) {
  const perms = useGuildPerms(guildId); const allowed = can(perms, Perm.USE_SOUNDBOARD) || can(perms, Perm.ADD_REACTIONS);
  const [cool, setCool] = useState(false);
  if (!allowed) return null;
  const send = (e: string) => {
    if (cool) return;
    setCool(true); setTimeout(() => setCool(false), 3000);
    api.voice.effect(channelId, e).catch((err) => { setCool(false); toastError(err); });
  };
  return (
    <div className="mb-2" role="group" aria-label={t('Voice effects')} data-testid="effect-row">
      <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-interactive">{t('Effects')}</span>
      <div className="flex flex-wrap gap-1">
        {EFFECT_EMOJIS.map((e) => <button key={e} disabled={cool} aria-label={`${t('Send effect')} ${e}`} onClick={() => send(e)} className="h-8 w-8 rounded bg-[rgb(var(--active))] text-lg leading-none hover:bg-[rgb(var(--divider))] disabled:opacity-50">{e}</button>)}
      </div>
    </div>
  );
}

function audioDuration(url: string): Promise<number> {
  return new Promise((res) => { const a = new Audio(url); a.onloadedmetadata = () => res(a.duration); a.onerror = () => res(0); });
}

/** Server Settings > Soundboard (MANAGE_EMOJIS): upload, rename, preview, delete. */
export function SoundboardTab({ guildId }: { guildId: Id }) {
  const q = useSounds(guildId); const qc = useQueryClient(); const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false); const [name, setName] = useState(''); const [emoji, setEmoji] = useState('');
  const sounds = q.data ?? [];
  const upload = async (f: File) => {
    setBusy(true);
    try {
      if (f.size > LIMITS.maxSoundBytes) throw new Error(`Sounds can be at most ${Math.round(LIMITS.maxSoundBytes / 1024)} KB`);
      const local = URL.createObjectURL(f); const dur = await audioDuration(local); URL.revokeObjectURL(local);
      if (dur > 10) throw new Error('Sounds can be at most 10 seconds long');
      const att = await api.files.upload(f);
      const nm = (name || f.name.replace(/\.[^.]+$/, '')).replace(/[^\w ]/g, '').slice(0, 32).trim();
      const s = await api.guilds.createSound(guildId, { name: nm.length < 2 ? 'sound' : nm, url: att.url, emoji: emoji || null });
      qc.setQueryData(['sounds', guildId], (old: SoundboardSound[] | undefined) => (old?.some((x) => x.id === s.id) ? old : [...(old ?? []), s]));
      setName(''); setEmoji(''); toast(t('Sound added'), 'success');
    } catch (e) { toastError(e); }
    setBusy(false);
  };
  const guildName = useData((s) => s.guilds[guildId]?.guild.name);
  return (
    <div>
      <H1>{t('Soundboard')}</H1>
      <p className="mb-4 text-sm text-muted">{sounds.length} / {LIMITS.maxSoundsPerServer} sounds in {guildName}. Clips play for everyone in your voice channel. Everyone gets {LIMITS.maxSoundsPerServer} slots, no paywall.</p>
      <div className="mb-6 flex flex-wrap items-end gap-3 rounded-lg bg-side p-3">
        <div className="min-w-[140px] flex-1"><span className="label">{t('Name')}</span><input className="field" aria-label={t('Sound name')} maxLength={32} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('airhorn')} /></div>
        <div className="w-24"><span className="label">{t('Emoji')}</span><input className="field" aria-label={t('Sound emoji')} maxLength={8} value={emoji} onChange={(e) => setEmoji(e.target.value)} placeholder="🔊" /></div>
        <input ref={file} hidden type="file" accept="audio/*" data-testid="sound-file" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f); }} />
        <button disabled={busy} className="btn btn-primary btn-lg" onClick={() => file.current?.click()}>{busy ? <Spinner /> : <Upload size={16} />} {t('Upload sound')}</button>
      </div>
      {!sounds.length && !q.isLoading && <Empty icon={<Volume2 size={40} />} title={t('No sounds yet')} />}
      <ul>{sounds.map((s) => (
        <li key={s.id} className="flex items-center gap-3 border-b border-divider/50 py-2">
          <button aria-label={`${t('Preview')} ${s.name}`} className="rounded p-2 hover:bg-hover" onClick={() => playClip(s.url, s.volume)}><Play size={16} /></button>
          <span aria-hidden>{s.emoji || '🔊'}</span><span className="flex-1 truncate text-sm">{s.name}</span>
          <input type="range" min={0} max={100} aria-label={`${s.name} volume`} defaultValue={Math.round(s.volume * 100)} className="w-24 accent-brand" onPointerUp={(e) => api.guilds.patchSound(guildId, s.id, { volume: Number((e.target as HTMLInputElement).value) / 100 }).catch(toastError)} />
          <button className="btn btn-secondary" onClick={() => useUI.getState().openModal({ kind: 'prompt', title: 'Rename Sound', label: 'Name', initial: s.name, onSubmit: (v) => api.guilds.patchSound(guildId, s.id, { name: v }).then((n) => { qc.setQueryData(["sounds", guildId], sounds.map((x) => (x.id === s.id ? n : x))); }).catch(toastError) })}>{t('Rename')}</button>
          <button aria-label={`Delete ${s.name}`} className="p-2 text-danger" onClick={() => api.guilds.deleteSound(guildId, s.id).then(() => qc.setQueryData(['sounds', guildId], sounds.filter((x) => x.id !== s.id))).catch(toastError)}><Trash2 size={16} /></button>
        </li>
      ))}</ul>
    </div>
  );
}
