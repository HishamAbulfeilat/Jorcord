import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PlusCircle, Smile, SendHorizonal, X, Eye, EyeOff, Hash, Image as ImageIcon, Gift } from 'lucide-react';
import { LIMITS, snowflake } from '@jorcord/shared';
import type { Channel } from '@jorcord/shared';
import { api } from '@/lib/api';
import { getGateway } from '@/lib/gateway';
import { useData } from '@/stores/data';
import { useUI, toastError, toast } from '@/stores/ui';
import { useMessages } from '@/stores/messages';
import { composerState } from '@/lib/perms';
import { cx, displayName, dmName, fmtBytes, isImage } from '@/lib/format';
import { toPlain, parseInline } from '@/lib/markdown';
import { searchEmoji, replaceShortcodes } from '@/lib/emoji';
import { useGuildPerms } from '@/lib/useGuild';
import { useIsMobile } from '@/lib/hooks';
import { Avatar } from '@/components/ui/Avatar';
import { myChannelPerms, ackLater } from '@/lib/session';
import { intToHex } from '@/lib/perms';

interface Staged { id: string; file: File; spoiler: boolean; preview?: string }
type Suggest = { kind: 'user' | 'role' | 'channel' | 'emoji'; items: { key: string; label: string; sub?: string; insert: string; token?: [string, string]; avatar?: any; icon?: string; color?: string }[]; index: number; start: number; end: number } | null;

export function Composer({ channel, stagedExternal }: { channel: Channel; stagedExternal?: File[] }) {
  const cid = channel.id; const gid = channel.guildId;
  const perms = useGuildPerms(gid ?? undefined, channel);
  const cs = gid ? composerState(perms, channel) : composerState(myChannelPerms(cid) | (1n << 15n) | (1n << 11n), channel);
  const draft = useUI((s) => s.drafts[cid] ?? ''); const setDraft = useUI((s) => s.setDraft);
  const replyId = useUI((s) => s.replyTo[cid]); const setReply = useUI((s) => s.setReply); const openPopout = useUI((s) => s.openPopout);
  const me = useData((s) => s.me); const mobile = useIsMobile();
  const [text, setText] = useState(draft); const [files, setFiles] = useState<Staged[]>([]);
  const [suggest, setSuggest] = useState<Suggest>(null); const [pingReply, setPingReply] = useState(true);
  const ta = useRef<HTMLTextAreaElement>(null); const fileInput = useRef<HTMLInputElement>(null);
  const tokens = useRef<Map<string, string>>(new Map());
  const replyMsg = useMessages((s) => (replyId ? s.ch[cid]?.list.find((m) => m.id === replyId) : undefined));
  const replyUser = useData((s) => (replyMsg ? s.users[replyMsg.author.id] ?? replyMsg.author : undefined));
  const guild = useData((s) => (gid ? s.guilds[gid] : undefined));
  const users = useData((s) => s.users);
  const placeholder = !cs.canSend ? (cs.reason ?? 'You cannot send messages here.') : channel.type === 'dm' || channel.type === 'group_dm' ? `Message @${dmName(channel, me?.id)}` : `Message #${channel.name}`;

  useEffect(() => { setText(draft); tokens.current.clear(); setFiles([]); /* eslint-disable-next-line */ }, [cid]);
  useEffect(() => { if (stagedExternal?.length) addFiles(stagedExternal); /* eslint-disable-next-line */ }, [stagedExternal]);
  useEffect(() => { const t = setTimeout(() => setDraft(cid, text), 300); return () => clearTimeout(t); }, [text, cid, setDraft]);
  useEffect(() => { if (replyId) ta.current?.focus(); }, [replyId]);
  useEffect(() => { // focus on typing anywhere (desktop)
    if (mobile) return;
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement; if (t.closest('input,textarea,select,[contenteditable],[role=dialog]') || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
      ta.current?.focus();
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, [mobile]);

  const resize = () => { const t = ta.current; if (!t) return; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, window.innerHeight * 0.45) + 'px'; };
  useEffect(resize, [text]);

  const addFiles = useCallback((fs: File[]) => {
    if (!cs.canAttach) { toast('You do not have permission to attach files here.', 'error'); return; }
    const ok = fs.filter((f) => { if (f.size > LIMITS.maxUploadBytes) { toast(`${f.name} is larger than ${fmtBytes(LIMITS.maxUploadBytes)}.`, 'error'); return false; } return true; });
    setFiles((cur) => [...cur, ...ok.map((file) => ({ id: snowflake(), file, spoiler: false, preview: isImage(file.type) ? URL.createObjectURL(file) : undefined }))].slice(0, 10));
  }, [cs.canAttach]);

  const compute = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    let m: RegExpMatchArray | null;
    if ((m = before.match(/(?:^|\s)@([\w.\-]{0,32})$/)) && gid && guild) {
      const q = m[1].toLowerCase(); const start = caret - m[1].length - 1;
      const members = Object.values(guild.members).filter((x) => (x.nick ?? x.user.displayName ?? x.user.username).toLowerCase().includes(q) || x.user.username.toLowerCase().includes(q)).slice(0, 8)
        .map((x) => ({ key: x.user.id, label: displayName(x.user, x), sub: x.user.username, insert: `@${x.user.username}`, token: [`@${x.user.username}`, `<@${x.user.id}>`] as [string, string], avatar: x.user }));
      const roles = Object.values(guild.roles).filter((r) => r.mentionable && r.id !== gid && r.name.toLowerCase().includes(q)).slice(0, 4).map((r) => ({ key: r.id, label: r.name, insert: `@${r.name.replace(/\s/g, '_')}`, token: [`@${r.name.replace(/\s/g, '_')}`, `<@&${r.id}>`] as [string, string], color: intToHex(r.color) }));
      const ev = ['everyone', 'here'].filter((x) => x.startsWith(q)).map((x) => ({ key: x, label: '@' + x, insert: '@' + x }));
      const items = [...members, ...roles, ...ev]; if (items.length) return { kind: 'user' as const, items, index: 0, start, end: caret };
    } else if ((m = before.match(/(?:^|\s)@([\w.\-]{1,32})$/)) && !gid) {
      const q = m[1].toLowerCase(); const start = caret - m[1].length - 1;
      const items = (channel.recipients ?? []).filter((u) => u.username.toLowerCase().includes(q)).map((u) => ({ key: u.id, label: displayName(u), sub: u.username, insert: `@${u.username}`, token: [`@${u.username}`, `<@${u.id}>`] as [string, string], avatar: u }));
      if (items.length) return { kind: 'user' as const, items, index: 0, start, end: caret };
    }
    if ((m = before.match(/(?:^|\s)#([\w\-]{0,32})$/)) && guild) {
      const q = m[1].toLowerCase(); const start = caret - m[1].length - 1;
      const items = Object.values(guild.channels).filter((c) => (c.type === 'text' || c.type === 'announcement' || c.type === 'voice' || c.type === 'forum') && c.name?.toLowerCase().includes(q)).slice(0, 8).map((c) => ({ key: c.id, label: c.name!, insert: `#${c.name}`, token: [`#${c.name}`, `<#${c.id}>`] as [string, string], icon: '#' }));
      if (items.length) return { kind: 'channel' as const, items, index: 0, start, end: caret };
    }
    if ((m = before.match(/(?:^|\s):([a-z0-9_+\-]{2,})$/i))) {
      const q = m[1].toLowerCase(); const start = caret - m[1].length - 1;
      const customs = Object.values(useData.getState().guilds).flatMap((g) => g.emojis).filter((e) => e.name.toLowerCase().includes(q)).slice(0, 6)
        .map((e) => ({ key: e.id, label: `:${e.name}:`, insert: `:${e.name}:`, token: [`:${e.name}:`, `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`] as [string, string], icon: e.url }));
      const uni = searchEmoji(q, 8).map((e) => ({ key: e.name, label: `:${e.name}:`, insert: e.char, icon: e.char }));
      const items = [...customs, ...uni].slice(0, 10); if (items.length) return { kind: 'emoji' as const, items, index: 0, start, end: caret };
    }
    return null;
  };

  const applySuggest = (s: NonNullable<Suggest>, i = s.index) => {
    const it = s.items[i]; if (!it) return;
    const t = ta.current!; const insert = it.insert + ' ';
    const next = text.slice(0, s.start) + insert + text.slice(s.end);
    if (it.token) tokens.current.set(it.token[0], it.token[1]);
    setText(next); setSuggest(null);
    requestAnimationFrame(() => { t.focus(); const p = s.start + insert.length; t.setSelectionRange(p, p); });
  };

  const finalize = (raw: string) => {
    let out = replaceShortcodes(raw);
    // longest tokens first so @bob_smith wins over @bob
    for (const [k, v] of [...tokens.current.entries()].sort((a, b) => b[0].length - a[0].length)) out = out.split(k).join(v);
    return out.trim();
  };

  const send = async (gif?: string) => {
    const content = gif ?? finalize(text);
    if (!cs.canSend || (!content && !files.length)) return;
    if (content.length > LIMITS.maxMessageLength) { toast(`Message is too long (${content.length}/${LIMITS.maxMessageLength}).`, 'error'); return; }
    const nonce = snowflake(); const toSend = files.map((f) => (f.spoiler && !f.file.name.startsWith('SPOILER_') ? new File([f.file], 'SPOILER_' + f.file.name, { type: f.file.type }) : f.file));
    const reply = replyId ?? null;
    useMessages.getState().addPending({ nonce, channelId: cid, content, files: toSend.map((f) => ({ name: f.name, size: f.size })), replyTo: reply, status: 'sending', createdAt: Date.now() });
    if (!gif) { setText(''); setFiles([]); setDraft(cid, ''); tokens.current.clear(); }
    setReply(cid, null); setSuggest(null);
    await deliver(nonce, cid, content, toSend, reply);
    const last = useMessages.getState().ch[cid]?.list.at(-1); if (last) ackLater(cid, last.id);
  };

  useEffect(() => {
    const h = async (e: Event) => {
      const nonce = (e as CustomEvent).detail as string; const p = useMessages.getState().pending.find((x) => x.nonce === nonce);
      if (!p || p.channelId !== cid) return;
      useMessages.getState().patchPending(nonce, { status: 'sending' });
      await deliver(nonce, cid, p.content, [], p.replyTo);
    };
    window.addEventListener('jorcord:retry', h); return () => window.removeEventListener('jorcord:retry', h);
  }, [cid]);

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggest) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setSuggest({ ...suggest, index: (suggest.index + (e.key === 'ArrowDown' ? 1 : suggest.items.length - 1)) % suggest.items.length }); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applySuggest(suggest); return; }
      if (e.key === 'Escape') { e.preventDefault(); setSuggest(null); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !mobile && !e.nativeEvent.isComposing) { e.preventDefault(); send(); return; }
    if (e.key === 'Escape') { if (replyId) setReply(cid, null); return; }
    if (e.key === 'ArrowUp' && !text) {
      const list = useMessages.getState().ch[cid]?.list ?? []; const mine = [...list].reverse().find((m) => m.author.id === me?.id && (m.type === 'default' || m.type === 'reply'));
      if (mine) { e.preventDefault(); useUI.getState().setEditing(mine.id); }
    }
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value); setSuggest(compute(e.target.value, e.target.selectionStart));
    if (e.target.value && cs.canSend) { const g = getGateway(); if (g.status === 'connected') g.sendTyping(cid); else throttledTyping(cid); }
  };
  const onPaste = (e: React.ClipboardEvent) => {
    const fs = [...e.clipboardData.files]; if (fs.length) { e.preventDefault(); addFiles(fs.map((f, i) => (f.name === 'image.png' ? new File([f], `pasted-${Date.now()}-${i}.png`, { type: f.type }) : f))); }
  };
  const insert = (s: string) => { const t = ta.current; const p = t?.selectionStart ?? text.length; setText(text.slice(0, p) + s + text.slice(p)); requestAnimationFrame(() => { t?.focus(); t?.setSelectionRange(p + s.length, p + s.length); }); };

  const over = text.length > LIMITS.maxMessageLength - 200;
  const canPostEmpty = files.length > 0; const hasText = text.trim().length > 0;
  const replyName = useMemo(() => (replyUser ? displayName(replyUser, gid ? guild?.members[replyUser.id] : undefined) : ''), [replyUser, gid, guild]);
  void users;

  return (
    <div className="relative shrink-0 px-4 pb-6 pt-0 max-md:pb-2" style={{ paddingBottom: mobile ? 'max(8px, var(--sab))' : undefined }}>
      {suggest && (
        <ul role="listbox" aria-label="Suggestions" className="absolute inset-x-4 bottom-full z-30 mb-1 max-h-72 overflow-y-auto rounded-md bg-float p-2 shadow-elev">
          <li className="px-2 pb-1 text-xs font-bold uppercase text-muted">{suggest.kind === 'user' ? 'Members' : suggest.kind === 'channel' ? 'Channels' : 'Emoji'}</li>
          {suggest.items.map((it, i) => (
            <li key={it.key} role="option" aria-selected={i === suggest.index}>
              <button onMouseDown={(e) => { e.preventDefault(); applySuggest(suggest, i); }} onMouseEnter={() => setSuggest({ ...suggest, index: i })} className={cx('touch flex w-full items-center gap-2 rounded px-2 py-1 text-left md:min-h-[34px]', i === suggest.index ? 'bg-hover' : '')}>
                {it.avatar ? <Avatar user={it.avatar} size={24} /> : it.icon?.startsWith('http') || it.icon?.startsWith('/') ? <img src={it.icon} alt="" className="h-6 w-6 object-contain" /> : <span className="flex h-6 w-6 items-center justify-center text-lg">{it.icon === '#' ? <Hash size={18} className="text-muted" /> : it.icon}</span>}
                <span className="font-medium text-header" style={{ color: it.color }}>{it.label}</span>{it.sub && <span className="text-sm text-muted">{it.sub}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className={cx('rounded-lg bg-[rgb(var(--composer))]', !cs.canSend && 'opacity-70')}>
        {replyId && (
          <div className="flex items-center justify-between rounded-t-lg bg-[rgb(var(--active)/0.6)] px-3 py-1.5 text-sm text-interactive">
            <span className="min-w-0 truncate">Replying to <b className="text-header">{replyName || '…'}</b>{replyMsg?.content && <span className="ml-2 text-muted">{toPlain(parseInline(replyMsg.content)).slice(0, 80)}</span>}</span>
            <span className="flex items-center gap-2">
              <button onClick={() => setPingReply(!pingReply)} aria-pressed={pingReply} className={cx('rounded px-1 text-xs font-bold', pingReply ? 'text-header' : 'text-muted')}>@ {pingReply ? 'ON' : 'OFF'}</button>
              <button aria-label="Cancel reply" onClick={() => setReply(cid, null)}><X size={18} /></button>
            </span>
          </div>
        )}
        {files.length > 0 && (
          <ul className="flex gap-3 overflow-x-auto border-b border-divider/40 p-3" aria-label="Attachments to upload">
            {files.map((f) => (
              <li key={f.id} className="relative w-[140px] shrink-0 rounded-md bg-side p-2">
                <div className="flex h-[100px] items-center justify-center overflow-hidden rounded bg-rail">{f.preview ? <img src={f.preview} alt="" className={cx('max-h-full max-w-full object-contain', f.spoiler && 'blur-md')} /> : <ImageIcon size={32} className="text-muted" />}</div>
                <div className="mt-1 truncate text-xs text-header" title={f.file.name}>{f.file.name}</div><div className="text-[11px] text-muted">{fmtBytes(f.file.size)}</div>
                <div className="absolute right-1 top-1 flex gap-0.5 rounded bg-chat/90 p-0.5">
                  <button aria-label={f.spoiler ? 'Remove spoiler' : 'Mark as spoiler'} aria-pressed={f.spoiler} onClick={() => setFiles((c) => c.map((x) => (x.id === f.id ? { ...x, spoiler: !x.spoiler } : x)))} className="p-1 text-interactive hover:text-header">{f.spoiler ? <EyeOff size={14} /> : <Eye size={14} />}</button>
                  <button aria-label="Remove attachment" onClick={() => setFiles((c) => c.filter((x) => x.id !== f.id))} className="p-1 text-danger"><X size={14} /></button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-end">
          <button aria-label="Upload a file" disabled={!cs.canAttach} onClick={() => fileInput.current?.click()} className="flex h-11 w-11 shrink-0 items-center justify-center text-interactive hover:text-interactive-hover disabled:cursor-not-allowed disabled:opacity-40"><PlusCircle size={24} /></button>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
          <textarea ref={ta} value={text} rows={1} disabled={!cs.canSend} placeholder={placeholder} aria-label={placeholder} enterKeyHint={mobile ? 'enter' : 'send'} onChange={onChange} onKeyDown={onKey} onPaste={onPaste} onBlur={() => setTimeout(() => setSuggest(null), 100)}
            className="max-h-[45vh] min-h-[44px] flex-1 resize-none bg-transparent py-[11px] text-[16px] leading-[22px] text-normal outline-none placeholder:text-muted disabled:cursor-not-allowed" />
          {over && <span className={cx('self-center pr-2 text-xs font-semibold', text.length > LIMITS.maxMessageLength ? 'text-danger' : 'text-muted')}>{LIMITS.maxMessageLength - text.length}</span>}
          <button aria-label="Choose emoji or GIF" disabled={!cs.canSend} onClick={(e) => openPopout({ kind: 'emoji', rect: e.currentTarget.getBoundingClientRect(), guildId: gid ?? undefined, onPick: (p) => { if ((p as any).gif) send((p as any).gif); else if (p.char) insert(p.char); else if (p.id) { tokens.current.set(`:${p.name}:`, `<${p.animated ? 'a' : ''}:${p.name}:${p.id}>`); insert(`:${p.name}: `); } } })} className="flex h-11 w-11 shrink-0 items-center justify-center text-interactive hover:text-interactive-hover disabled:opacity-40"><Smile size={24} /></button>
          {mobile && (hasText || canPostEmpty) && <button aria-label="Send message" onClick={() => send()} className="m-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand text-white"><SendHorizonal size={18} /></button>}
          {!mobile && <span className="hidden"><Gift size={0} /></span>}
        </div>
      </div>
    </div>
  );
}

const lastTyping = new Map<string, number>();
function throttledTyping(cid: string) { const n = Date.now(); if ((lastTyping.get(cid) ?? 0) + 8000 > n) return; lastTyping.set(cid, n); api.channels.typing(cid).catch(() => {}); }

async function deliver(nonce: string, cid: string, content: string, files: File[], reply: string | null) {
  const st = useMessages.getState();
  try {
    const msg = await api.messages.send(cid, { content, files, replyTo: reply, nonce });
    st.upsert(msg); st.dropPending(nonce);
    useData.getState().apply('MESSAGE_CREATE', msg);
  } catch (e) { st.patchPending(nonce, { status: 'failed' }); toastError(e); }
}
