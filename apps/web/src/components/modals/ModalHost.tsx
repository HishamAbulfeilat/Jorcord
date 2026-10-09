import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { Check, Copy, Gamepad2, GraduationCap, Hash, Heart, Megaphone, MessagesSquare, Mic, Plus, Radio, Users, X, Upload, Globe, Palette, Volume2 } from 'lucide-react';
import { Perm } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { useUI, toast, toastError, defaultKeybinds } from '@/stores/ui';
import { Modal, Field, Spinner } from '@/components/ui/primitives';
import { Avatar } from '@/components/ui/Avatar';
import { cx, copyText, displayName, fileUrl, inviteUrl, initials } from '@/lib/format';
import { useNav } from '@/lib/nav';
import { ProfileCard } from './Profile';
import { ChannelSettings } from '@/components/settings/ChannelSettings';
import { goto } from '@/lib/menus';
import { VoiceSettingsModal } from '@/voice/VoiceSettings';

const TEMPLATES = [
  { id: 'own', label: 'Create My Own', icon: Palette }, { id: 'gaming', label: 'Gaming', icon: Gamepad2 }, { id: 'friends', label: 'Friends', icon: Heart },
  { id: 'study', label: 'Study Group', icon: GraduationCap }, { id: 'club', label: 'School Club', icon: Users }, { id: 'community', label: 'Local Community', icon: Globe },
];

export const fileToDataUrl = (f: File): Promise<string> => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(f); });

export async function uploadImageFile(f: File): Promise<string> { return api.files.uploadImage(f); }

export function IconPicker({ value, onChange, label = 'Upload', size = 80 }: { value: string | null; onChange: (v: string | null) => void; label?: string; size?: number }) {
  const ref = useRef<HTMLInputElement>(null); const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-center gap-4">
      <button type="button" onClick={() => ref.current?.click()} aria-label={`${label} image`} className="relative flex items-center justify-center overflow-hidden rounded-full border-2 border-dashed border-muted text-muted hover:text-header" style={{ width: size, height: size }}>
        {busy ? <Spinner /> : value ? <img src={fileUrl(value) ?? value} alt="" className="h-full w-full object-cover" /> : <span className="flex flex-col items-center text-[10px] font-bold uppercase"><Upload size={22} />{label}</span>}
      </button>
      <input ref={ref} hidden type="file" accept="image/*" onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; setBusy(true); try { onChange(await uploadImageFile(f)); } catch (err) { toastError(err); } setBusy(false); }} />
      {value && <button type="button" className="text-sm text-link hover:underline" onClick={() => onChange(null)}>Remove</button>}
    </div>
  );
}

function CreateServer({ close }: { close: () => void }) {
  const me = useData((s) => s.me); const nav = useNav(); const open = useUI((s) => s.openModal);
  const [step, setStep] = useState<'pick' | 'name'>('pick'); const [tpl, setTpl] = useState('own');
  const [name, setName] = useState(me ? `${me.displayName || me.username}'s server` : ''); const [icon, setIcon] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    try { const g = await api.guilds.create({ name: name.trim(), icon, template: ({ own: 'default', friends: 'default', club: 'study' } as Record<string, string>)[tpl] ?? tpl }); useData.getState().putGuild(g); close(); const ch = Object.values(g.channels ?? {}).sort((a, b) => a.position - b.position).find((c) => c.type === 'text'); nav.go(g.id, ch?.id); }
    catch (err) { toastError(err); setBusy(false); }
  };
  if (step === 'pick') return (
    <Modal title="Create Your Server" onClose={close} footer={<div className="flex w-full flex-col items-center gap-1"><span className="font-bold text-header">Have an invite already?</span><button className="btn btn-secondary w-full" onClick={() => open({ kind: 'joinServer' })}>Join a Server</button></div>}>
      <p className="mb-4 text-center text-sm text-muted">Your server is where you and your friends hang out. Make yours and start talking.</p>
      <ul className="grid gap-2">{TEMPLATES.map((t) => <li key={t.id}><button onClick={() => { setTpl(t.id); setStep('name'); }} className="touch flex w-full items-center gap-3 rounded-lg border border-divider bg-modal-alt px-4 py-3 text-left font-bold text-header hover:bg-hover"><t.icon size={28} className="text-brand" /><span className="flex-1">{t.label}</span><span className="text-muted">›</span></button></li>)}</ul>
    </Modal>
  );
  return (
    <Modal title="Customize Your Server" onClose={close} footer={<><button className="btn btn-link" onClick={() => setStep('pick')}>Back</button><button form="cs" type="submit" disabled={!name.trim() || busy} className="btn btn-primary btn-lg sm:ml-auto">Create</button></>}>
      <form id="cs" onSubmit={submit}>
        <p className="mb-4 text-center text-sm text-muted">Give your new server a personality with a name and an icon. You can always change it later.</p>
        <div className="mb-4 flex justify-center"><IconPicker value={icon} onChange={setIcon} /></div>
        <Field label="Server Name"><input className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus /></Field>
        <p className="text-xs text-muted">By creating a server, you agree to be kind to each other.</p>
      </form>
    </Modal>
  );
}

function JoinServer({ close, code: initial }: { close: () => void; code?: string }) {
  const nav = useNav(); const [v, setV] = useState(initial ?? ''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const disc = useQuery({ queryKey: ['discover'], queryFn: api.guilds.discover, retry: false });
  const code = v.trim().replace(/^.*\/invite\//, '').replace(/^.*\//, '');
  const join = async (c: string) => {
    setBusy(true); setErr('');
    try { const r = await api.invites.join(c); const gid = r.guild?.id ?? r.guildId ?? r.id; if (r.guild) useData.getState().putGuild(r.guild); else if (r.channels) useData.getState().putGuild(r as any); close(); nav.go(gid); }
    catch (e) { setErr((e as Error).message || 'The invite is invalid or has expired.'); setBusy(false); }
  };
  return (
    <Modal title="Join a Server" onClose={close} footer={<><button className="btn btn-link" onClick={close}>Cancel</button><button disabled={!code || busy} onClick={() => join(code)} className="btn btn-primary btn-lg sm:ml-auto">Join Server</button></>}>
      <p className="mb-4 text-center text-sm text-muted">Enter an invite below to join an existing server.</p>
      <Field label="Invite link *"><input className="field" value={v} onChange={(e) => setV(e.target.value)} placeholder={`${location.origin}/invite/aBcDeF`} autoFocus onKeyDown={(e) => { if (e.key === 'Enter' && code) join(code); }} /></Field>
      {err && <p className="-mt-2 mb-3 text-sm text-danger" role="alert">{err}</p>}
      {disc.data && disc.data.length > 0 && (<><h3 className="section-title mb-2">Discoverable servers</h3><ul className="grid gap-2">{disc.data.slice(0, 6).map((g) => (
        <li key={g.id} className="flex items-center gap-3 rounded-lg bg-modal-alt p-2"><span className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-xl bg-brand text-sm font-bold text-white">{g.icon ? <img src={fileUrl(g.icon)!} alt="" className="h-full w-full object-cover" /> : initials(g.name)}</span><span className="min-w-0 flex-1"><span className="block truncate font-semibold text-header">{g.name}</span><span className="block truncate text-xs text-muted">{g.description}</span></span><button className="btn btn-secondary" onClick={() => api.guilds.get(g.id).then((full) => { useData.getState().putGuild(full); close(); nav.go(g.id); }).catch(toastError)}>View</button></li>))}</ul></>)}
    </Modal>
  );
}

function CreateChannel({ close, guildId, parentId, category }: { close: () => void; guildId: string; parentId?: string | null; category?: boolean }) {
  const [type, setType] = useState(category ? 'category' : 'text'); const [name, setName] = useState(''); const [priv, setPriv] = useState(false); const [busy, setBusy] = useState(false); const nav = useNav();
  const types = [{ id: 'text', label: 'Text', desc: 'Send messages, images, GIFs, emoji, opinions, and puns', icon: Hash }, { id: 'voice', label: 'Voice', desc: 'Hang out together with voice, video, and screen share', icon: Volume2 }, { id: 'announcement', label: 'Announcement', desc: 'Important updates for people who follow your server', icon: Megaphone }, { id: 'forum', label: 'Forum', desc: 'Create a space for organized discussions', icon: MessagesSquare }, { id: 'stage', label: 'Stage', desc: 'Host events with speakers and an audience', icon: Radio }];
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    try {
      const n = type === 'category' ? name.trim() : name.trim().toLowerCase().replace(/\s+/g, '-');
      const c = await api.guilds.createChannel(guildId, { name: n, type: type as any, parentId: parentId ?? null, ...(priv ? { overwrites: [{ id: guildId, type: 'role', allow: '0', deny: Perm.VIEW_CHANNEL.toString() }] } : {}) } as any);
      useData.getState().apply('CHANNEL_CREATE', c); close(); if (c.type !== 'category') nav.go(guildId, c.id);
    } catch (err) { toastError(err); setBusy(false); }
  };
  return (
    <Modal title={category ? 'Create Category' : 'Create Channel'} onClose={close} footer={<><button className="btn btn-link" onClick={close}>Cancel</button><button form="cc" type="submit" disabled={!name.trim() || busy} className="btn btn-primary btn-lg sm:ml-auto">Create {category ? 'Category' : 'Channel'}</button></>}>
      <form id="cc" onSubmit={submit}>
        {!category && <fieldset className="mb-4"><legend className="label">Channel Type</legend><div className="grid gap-2" role="radiogroup">{types.map((t) => <label key={t.id} className={cx('flex cursor-pointer items-center gap-3 rounded-md bg-modal-alt p-3 hover:bg-hover', type === t.id && 'bg-active')}><t.icon size={24} className="text-muted" /><span className="flex-1"><span className="block font-semibold text-header">{t.label}</span><span className="block text-xs text-muted">{t.desc}</span></span><input type="radio" name="ct" checked={type === t.id} onChange={() => setType(t.id)} className="h-5 w-5 accent-brand" /></label>)}</div></fieldset>}
        <Field label={category ? 'Category Name' : 'Channel Name'}><div className="relative">{!category && <Hash size={16} className="absolute left-2.5 top-3 text-muted" />}<input className={cx('field', !category && 'pl-8')} value={name} onChange={(e) => setName(e.target.value)} placeholder={category ? 'New Category' : 'new-channel'} autoFocus maxLength={100} /></div></Field>
        <label className="flex items-center justify-between text-sm"><span><b className="text-header">Private {category ? 'Category' : 'Channel'}</b><br /><span className="text-muted">Only selected members and roles will be able to view it.</span></span><input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} className="h-5 w-5 accent-brand" /></label>
      </form>
    </Modal>
  );
}

function InviteModal({ close, guildId, channelId }: { close: () => void; guildId: string; channelId?: string }) {
  const g = useData((s) => s.guilds[guildId]); const [age, setAge] = useState<number | null>(604800); const [uses, setUses] = useState<number | null>(null); const [code, setCode] = useState(''); const [busy, setBusy] = useState(true); const [copied, setCopied] = useState(false);
  const cid = channelId ?? Object.values(g?.channels ?? {}).find((c) => c.type === 'text')?.id;
  const make = async () => { setBusy(true); try { const i = await api.guilds.createInvite(guildId, { channelId: cid, maxAgeSeconds: age, maxUses: uses }); setCode(i.code); } catch (e) { toastError(e); } setBusy(false); };
  useEffect(() => { make(); /* eslint-disable-next-line */ }, [age, uses]);
  const url = code ? inviteUrl(code) : '';
  return (
    <Modal title={`Invite friends to ${g?.guild.name ?? 'server'}`} onClose={close}>
      <p className="mb-2 text-sm text-muted">Send a server invite link to a friend</p>
      <div className="flex gap-2 rounded bg-rail p-1"><input readOnly value={busy ? 'Generating…' : url} aria-label="Invite link" onFocus={(e) => e.target.select()} className="min-w-0 flex-1 bg-transparent px-2 text-sm outline-none" /><button disabled={!url} onClick={() => copyText(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); })} className={cx('btn', copied ? 'btn-primary !bg-success' : 'btn-primary')}>{copied ? <><Check size={14} />Copied</> : 'Copy'}</button></div>
      <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <label><span className="label">Expire after</span><select className="field" value={age ?? 0} onChange={(e) => setAge(Number(e.target.value) || null)}>{[[1800, '30 minutes'], [3600, '1 hour'], [21600, '6 hours'], [43200, '12 hours'], [86400, '1 day'], [604800, '7 days'], [0, 'Never']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label><span className="label">Max uses</span><select className="field" value={uses ?? 0} onChange={(e) => setUses(Number(e.target.value) || null)}>{[[0, 'No limit'], [1, '1 use'], [5, '5 uses'], [10, '10 uses'], [25, '25 uses'], [50, '50 uses'], [100, '100 uses']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      </div>
    </Modal>
  );
}

function NewDm({ close, addTo }: { close: () => void; addTo?: string }) {
  const rels = useData((s) => s.relationships); const [sel, setSel] = useState<string[]>([]); const [q, setQ] = useState(''); const [busy, setBusy] = useState(false);
  const friends = Object.values(rels).filter((r) => r.type === 'friend' && displayName(r.user).toLowerCase().includes(q.toLowerCase()));
  const go = async () => { setBusy(true); try { if (addTo) { for (const id of sel) await api.channels.addRecipient(addTo, id); close(); return; } const c = await api.users.openDm(sel); useData.getState().putDm(c); close(); goto(null, c.id); } catch (e) { toastError(e); setBusy(false); } };
  return (
    <Modal title="Select Friends" onClose={close} footer={<><button className="btn btn-link" onClick={close}>Cancel</button><button disabled={!sel.length || busy} onClick={go} className="btn btn-primary btn-lg sm:ml-auto">{sel.length > 1 ? 'Create Group DM' : 'Create DM'}</button></>}>
      <p className="mb-3 text-center text-sm text-muted">You can add {Math.max(0, 9 - sel.length)} more friends.</p>
      <input className="field mb-3" placeholder="Type the username of a friend" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <ul className="max-h-72 overflow-y-auto">{friends.map((r) => <li key={r.user.id}><label className="touch flex cursor-pointer items-center gap-3 rounded px-2 hover:bg-hover"><Avatar user={r.user} size={32} /><span className="flex-1 truncate font-medium text-header">{displayName(r.user)}</span><input type="checkbox" className="h-5 w-5 accent-brand" checked={sel.includes(r.user.id)} onChange={(e) => setSel(e.target.checked ? [...sel, r.user.id].slice(0, 9) : sel.filter((x) => x !== r.user.id))} /></label></li>)}</ul>
      {!friends.length && <p className="py-6 text-center text-sm text-muted">No friends found.</p>}
    </Modal>
  );
}

function Simple({ title, body, confirmLabel = 'Confirm', danger, onConfirm, close }: { title: string; body: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void | Promise<void>; close: () => void }) {
  const [busy, setBusy] = useState(false);
  return <Modal title={title} width={420} onClose={close} footer={<><button className="btn btn-link" onClick={close}>Cancel</button><button disabled={busy} className={cx('btn btn-lg sm:ml-auto', danger ? 'btn-danger' : 'btn-primary')} onClick={async () => { setBusy(true); await onConfirm(); close(); }}>{confirmLabel}</button></>}><p className="text-center text-normal">{body}</p></Modal>;
}

function Prompt({ title, label, initial = '', onSubmit, close }: { title: string; label: string; initial?: string; onSubmit: (v: string) => void | Promise<void>; close: () => void }) {
  const [v, setV] = useState(initial);
  return <Modal title={title} width={420} onClose={close} footer={<><button className="btn btn-link" onClick={close}>Cancel</button><button form="pr" type="submit" className="btn btn-primary btn-lg sm:ml-auto">Confirm</button></>}><form id="pr" onSubmit={async (e) => { e.preventDefault(); await onSubmit(v); close(); }}><Field label={label}><input className="field" value={v} onChange={(e) => setV(e.target.value)} autoFocus /></Field></form></Modal>;
}

function ImageLightbox({ url, name, close }: { url: string; name?: string; close: () => void }) {
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && close(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [close]);
  return createPortal(
    <div className="fixed inset-0 z-[90] flex flex-col items-center justify-center bg-black/85 p-4" role="dialog" aria-label="Image preview" onClick={close}>
      <button aria-label="Close preview" className="absolute right-4 top-4 text-white" style={{ top: 'calc(var(--sat) + 16px)' }}><X size={28} /></button>
      <img src={url} alt={name ?? ''} onClick={(e) => e.stopPropagation()} className="max-h-[85dvh] max-w-full rounded object-contain" />
      <a href={url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="mt-3 text-sm text-white/80 hover:underline">Open original</a>
    </div>, document.body);
}

function CreateThread({ channelId, messageId, suggested, close }: { channelId: string; messageId: string; suggested?: string; close: () => void }) {
  const nav = useNav(); const [name, setName] = useState(suggested ?? ''); const [busy, setBusy] = useState(false); const g = useData((s) => s.guilds);
  return <Modal title="Create Thread" width={420} onClose={close} footer={<><button className="btn btn-link" onClick={close}>Cancel</button><button form="ct" type="submit" disabled={!name.trim() || busy} className="btn btn-primary btn-lg sm:ml-auto">Create Thread</button></>}>
    <form id="ct" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { const t = await api.messages.createThread(channelId, messageId, name.trim()); useData.getState().apply('THREAD_CREATE', t); close(); nav.go(t.guildId, t.id); } catch (err) { toastError(err); setBusy(false); } }}>
      <Field label="Thread Name"><input className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus /></Field></form>{void g}</Modal>;
}
function ForumPost({ channelId, close }: { channelId: string; close: () => void }) {
  const nav = useNav(); const [name, setName] = useState(''); const [content, setContent] = useState(''); const [busy, setBusy] = useState(false);
  return <Modal title="New Post" onClose={close} footer={<><button className="btn btn-link" onClick={close}>Cancel</button><button form="fp" type="submit" disabled={!name.trim() || !content.trim() || busy} className="btn btn-primary btn-lg sm:ml-auto">Post</button></>}>
    <form id="fp" onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { const r = await api.channels.forumPost(channelId, { name: name.trim(), content: content.trim() }); const t = r.channel ?? (r as any); useData.getState().apply('THREAD_CREATE', t); close(); nav.go(t.guildId, t.id); } catch (err) { toastError(err); setBusy(false); } }}>
      <Field label="Post Title"><input className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus /></Field>
      <Field label="Message"><textarea className="field min-h-[120px]" value={content} onChange={(e) => setContent(e.target.value)} /></Field></form></Modal>;
}

function Shortcuts({ close }: { close: () => void }) {
  const kb = useUI((s) => s.prefs.keybinds);
  const labels: Record<string, string> = { quickSwitcher: 'Quick switcher', markRead: 'Mark channel as read', prevChannel: 'Previous channel', nextChannel: 'Next channel', prevServer: 'Previous server', nextServer: 'Next server', toggleMembers: 'Toggle member list', search: 'Search', shortcuts: 'Keyboard shortcuts', toggleMute: 'Toggle mute', toggleDeafen: 'Toggle deafen', pushToTalk: 'Push to talk' };
  return <Modal title="Keyboard Shortcuts" onClose={close}><ul>{Object.entries(labels).map(([k, l]) => <li key={k} className="flex items-center justify-between border-b border-divider/50 py-2 text-sm"><span>{l}</span><kbd className="rounded bg-rail px-2 py-0.5 font-mono text-xs text-header">{kb[k] ?? defaultKeybinds[k]}</kbd></li>)}</ul></Modal>;
}

function Reactors({ spec, close }: { spec: { channelId: string; messageId: string; emoji: string; emojiId: string | null }; close: () => void }) {
  const q = useQuery({ queryKey: ['reactors', spec], queryFn: () => api.messages.reactors(spec.channelId, spec.messageId, spec.emoji, spec.emojiId) });
  return <Modal title={`${spec.emoji} Reactions`} onClose={close} width={380}>{q.isLoading ? <Spinner className="mx-auto" /> : <ul>{q.data?.map((u) => <li key={u.id} className="flex items-center gap-3 py-1.5"><Avatar user={u} size={28} /><span className="font-medium text-header">{displayName(u)}</span></li>)}</ul>}</Modal>;
}

function LeaveGuild({ guildId, close }: { guildId: string; close: () => void }) {
  const g = useData((s) => s.guilds[guildId]?.guild); const nav = useNav();
  return <Simple title={`Leave '${g?.name}'`} body="Are you sure you want to leave? You won't be able to rejoin this server unless you are re-invited." confirmLabel="Leave Server" danger close={close} onConfirm={async () => { try { await api.users.leaveGuild(guildId); useData.getState().apply('GUILD_DELETE', { id: guildId }); nav.home(); } catch (e) { toastError(e); } }} />;
}

export function ModalHost() {
  const m = useUI((s) => s.modal); const close = useUI((s) => s.closeModal);
  if (!m) return null;
  switch (m.kind) {
    case 'createServer': return <CreateServer close={close} />;
    case 'joinServer': return <JoinServer close={close} code={m.code} />;
    case 'createChannel': return <CreateChannel close={close} guildId={m.guildId} parentId={m.parentId} />;
    case 'createCategory': return <CreateChannel close={close} guildId={m.guildId} category />;
    case 'invite': return <InviteModal close={close} guildId={m.guildId} channelId={m.channelId} />;
    case 'profile': return <Modal onClose={close} width={380} padded={false}><ProfileCard userId={m.userId} guildId={m.guildId} /></Modal>;
    case 'confirm': return <Simple {...m} close={close} />;
    case 'prompt': return <Prompt {...m} close={close} />;
    case 'image': return <ImageLightbox url={m.url} name={m.name} close={close} />;
    case 'createThread': return <CreateThread channelId={m.channelId} messageId={m.messageId} suggested={m.suggested} close={close} />;
    case 'createForumPost': return <ForumPost channelId={m.channelId} close={close} />;
    case 'newDm': return <NewDm close={close} addTo={m.addTo} />;
    case 'shortcuts': return <Shortcuts close={close} />;
    case 'voiceSettings': return <VoiceSettingsModal onClose={close} />;
    case 'reactors': return <Reactors spec={m} close={close} />;
    case 'leaveGuild': return <LeaveGuild guildId={m.guildId} close={close} />;
    case 'channelSettings': return <ChannelSettings channelId={m.channelId} close={close} />;
  }
}
void Plus; void Copy; void Mic;
