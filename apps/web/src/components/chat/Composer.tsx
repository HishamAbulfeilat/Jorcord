import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseWarnCommand } from '@/lib/modtools';
import { Mic, PlusCircle, Smile, SendHorizonal, X, Eye, EyeOff, Hash, Image as ImageIcon, Gift, Upload, BarChart3, CalendarClock, BellOff, Link2Off, Timer } from 'lucide-react';
import { LIMITS, Perm, snowflake } from '@jorcord/shared';
import type { AllowedMentions, ApplicationCommand, Channel } from '@jorcord/shared';
import { api } from '@/lib/api';
import { getGateway } from '@/lib/gateway';
import { useData } from '@/stores/data';
import { useUI, toastError, toast } from '@/stores/ui';
import { useMessages } from '@/stores/messages';
import { composerState } from '@/lib/perms';
import { cx, displayName, dmName, fmtBytes, isImage, fileUrl } from '@/lib/format';
import { toPlain, parseInline } from '@/lib/markdown';
import { VoiceRecorder } from '@/lib/voiceRecord';
import { ensurePermission, reportPermissionFailure } from '@/lib/permissionFlow';
import { queryPermission } from '@/lib/permissions';
import { fmtVoiceDuration, waveformPeaks } from '@/lib/voiceMsg';
import { VoicePlayer, WaveformBars } from './Attachments';
import { searchEmoji, replaceShortcodes } from '@/lib/emoji';
import { useGuildPerms } from '@/lib/useGuild';
import { useIsMobile } from '@/lib/hooks';
import { Avatar } from '@/components/ui/Avatar';
import { myChannelPerms, ackLater } from '@/lib/session';
import { intToHex } from '@/lib/perms';
import { t } from '@/i18n';
import { SlashForm, useCommandCatalog } from './SlashCommands';
import { filterCommands, parseSlash } from '@/lib/commands';
import { can } from '@/lib/perms';
import { selfMember } from '@/stores/data';
import { SecretBar } from './SecretChat';
import { SecretChatError, sendSecretMessage } from '@/lib/e2ee/service';
import { useSecret } from '@/stores/secret';
import { parseSendOptions } from '@/lib/composerCommands';
import { loadDraft, saveDraft } from '@/lib/drafts';
import { bypassesSlowmode, fmtSlowmode, slowmodeRemaining } from '@/lib/slowmode';
import type { ApiException } from '@/lib/transport';

interface Staged { id: string; file: File; spoiler: boolean; preview?: string; /** Alt text (<= 1024 chars), sent as the attachment description. */ alt: string }
type Suggest = { kind: 'user' | 'role' | 'channel' | 'emoji' | 'command'; items: { key: string; label: string; sub?: string; insert: string; token?: [string, string]; avatar?: any; icon?: string; color?: string; command?: ApplicationCommand; app?: string }[]; index: number; start: number; end: number } | null;

export function Composer({ channel, stagedExternal }: { channel: Channel; stagedExternal?: File[] }) {
  const cid = channel.id; const gid = channel.guildId;
  const perms = useGuildPerms(gid ?? undefined, channel);
  const pending = useData((s) => (gid ? !!selfMember(s, gid)?.pending : false));
  const secret = !!channel.encrypted; // end-to-end encrypted 1:1 chat: text only, encrypted on this device before it is sent
  const cs0 = gid ? composerState(perms, channel, { pending }) : composerState(myChannelPerms(cid) | (1n << 15n) | (1n << 11n), channel);
  const cs = secret ? { ...cs0, canAttach: false } : cs0;
  const canSlash = !!gid && cs.canSend && can(perms, Perm.USE_SLASH_COMMANDS);
  const catalog = useCommandCatalog(gid, cid, canSlash);
  const catalogRef = useRef(catalog.data); catalogRef.current = catalog.data;
  const [slash, setSlash] = useState<ApplicationCommand | null>(null);
  const openModal = useUI((s) => s.openModal); const openMenu = useUI((s) => s.openMenu);
  const draft = useUI((s) => s.drafts[cid] ?? ''); const setDraft = useUI((s) => s.setDraft);
  const replyId = useUI((s) => s.replyTo[cid]); const setReply = useUI((s) => s.setReply); const openPopout = useUI((s) => s.openPopout);
  const me = useData((s) => s.me); const mobile = useIsMobile();
  const [text, setText] = useState(() => draft || loadDraft(useData.getState().me?.id, cid)); const [files, setFiles] = useState<Staged[]>([]);
  const [silent, setSilent] = useState(false); const [noEmbeds, setNoEmbeds] = useState(false); const [altOpen, setAltOpen] = useState<string | null>(null);
  // slowmode countdown: the newest message of mine in this channel, or a deadline learned from a send / a 429
  const lastOwnId = useMessages((s) => { const l = s.ch[cid]?.list; if (!l) return null; for (let i = l.length - 1; i >= 0; i--) if (l[i]!.author.id === useData.getState().me?.id && (l[i]!.type === 'default' || l[i]!.type === 'reply')) return l[i]!.id; return null; });
  const [slowUntil, setSlowUntil] = useState(0); const [now, setNow] = useState(() => Date.now());
  const slowBypass = !gid || bypassesSlowmode(perms);
  const slowLeft = slowmodeRemaining({ slowmode: channel.slowmode ?? 0, lastOwnMessageId: lastOwnId, until: slowUntil, now, bypass: slowBypass });
  useEffect(() => { if (slowLeft <= 0) return; const i = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(i); }, [slowLeft > 0]); // eslint-disable-line
  const [suggest, setSuggest] = useState<Suggest>(null); const [pingReply, setPingReply] = useState(true); // reply "@ ON/OFF": ping the replied user?
  const allowedMentions = useMemo(() => (replyId && !pingReply ? { parse: ['users', 'roles', 'everyone'] as AllowedMentions['parse'] } : undefined), [replyId, pingReply]);
  const ta = useRef<HTMLTextAreaElement>(null); const fileInput = useRef<HTMLInputElement>(null);
  const recRef = useRef<VoiceRecorder | null>(null);
  const [recording, setRecording] = useState(false);
  const [live, setLive] = useState<{ peaks: number[]; at: number } | null>(null);
  const [preview, setPreview] = useState<{ file: File; peaks: number[]; duration: number; url: string } | null>(null);
  const tokens = useRef<Map<string, string>>(new Map());
  const replyMsg = useMessages((s) => (replyId ? s.ch[cid]?.list.find((m) => m.id === replyId) : undefined));
  const replyUser = useData((s) => (replyMsg ? s.users[replyMsg.author.id] ?? replyMsg.author : undefined));
  const guild = useData((s) => (gid ? s.guilds[gid] : undefined));
  const users = useData((s) => s.users);
  const placeholder = !cs.canSend ? (cs.reason ?? 'You cannot send messages here.') : channel.type === 'dm' || channel.type === 'group_dm' ? `${secret ? 'Secret message to' : 'Message'} @${dmName(channel, me?.id)}` : `Message #${channel.name}`;

  useEffect(() => { setText(draft || loadDraft(useData.getState().me?.id, cid)); tokens.current.clear(); setFiles([]); setSlash(null); setSilent(false); setNoEmbeds(false); setAltOpen(null); setSlowUntil(0); /* eslint-disable-next-line */ }, [cid]);
  useEffect(() => { if (stagedExternal?.length) addFiles(stagedExternal); /* eslint-disable-next-line */ }, [stagedExternal]);
  useEffect(() => { const t = setTimeout(() => { setDraft(cid, text); saveDraft(useData.getState().me?.id, cid, text); }, 300); return () => clearTimeout(t); }, [text, cid, setDraft]);
  const textRef = useRef(text); textRef.current = text;
  useEffect(() => { const h = () => saveDraft(useData.getState().me?.id, cid, textRef.current); window.addEventListener('pagehide', h); window.addEventListener('beforeunload', h); return () => { window.removeEventListener('pagehide', h); window.removeEventListener('beforeunload', h); }; }, [cid]); // a reload within the debounce still keeps the draft
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
    if (!cs.canAttach) { toast(secret ? t('Secret chats are text only: attachments are not supported.') : t('You do not have permission to attach files here.'), 'error'); return; }
    const ok = fs.filter((f) => { if (f.size > LIMITS.maxUploadBytes) { toast(`${f.name} is larger than ${fmtBytes(LIMITS.maxUploadBytes)}.`, 'error'); return false; } return true; });
    setFiles((cur) => [...cur, ...ok.map((file) => ({ id: snowflake(), file, spoiler: false, preview: isImage(file.type) ? URL.createObjectURL(file) : undefined, alt: '' }))].slice(0, 10));
  }, [cs.canAttach]);

  const compute = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    let m: RegExpMatchArray | null;
    const sl = canSlash ? parseSlash(value) : null;
    if (sl && !sl.hasSpace && catalogRef.current) {
      const apps = new Map(catalogRef.current.applications.map((a) => [a.id, a]));
      const items = filterCommands(catalogRef.current.commands, sl.name).map((c) => ({ key: c.id, label: `/${c.name}`, sub: c.description, insert: `/${c.name}`, command: c, app: apps.get(c.applicationId)?.name, avatar: { id: c.applicationId, username: apps.get(c.applicationId)?.name ?? 'app', displayName: apps.get(c.applicationId)?.name ?? 'app', avatar: apps.get(c.applicationId)?.icon ?? null } }));
      return items.length ? { kind: 'command' as const, items, index: 0, start: 0, end: value.length } : null;
    }
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
      const items = Object.values(guild.channels).filter((c) => (c.type === 'text' || c.type === 'announcement' || c.type === 'voice' || c.type === 'forum' || c.type === 'media') && c.name?.toLowerCase().includes(q)).slice(0, 8).map((c) => ({ key: c.id, label: c.name!, insert: `#${c.name}`, token: [`#${c.name}`, `<#${c.id}>`] as [string, string], icon: '#' }));
      if (items.length) return { kind: 'channel' as const, items, index: 0, start, end: caret };
    }
    if ((m = before.match(/(?:^|\s):([a-z0-9_+\-]{2,})$/i))) {
      const q = m[1].toLowerCase(); const start = caret - m[1].length - 1;
      const customs = Object.values(useData.getState().guilds).flatMap((g) => g.emojis).filter((e) => e.name.toLowerCase().includes(q)).slice(0, 6)
        .map((e) => ({ key: e.id, label: `:${e.name}:`, insert: `:${e.name}:`, token: [`:${e.name}:`, `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`] as [string, string], icon: fileUrl(e.url) ?? e.url }));
      const uni = searchEmoji(q, 8).map((e) => ({ key: e.name, label: `:${e.name}:`, insert: e.char, icon: e.char }));
      const items = [...customs, ...uni].slice(0, 10); if (items.length) return { kind: 'emoji' as const, items, index: 0, start, end: caret };
    }
    return null;
  };

  // a refreshed catalog may now know the command being typed
  useEffect(() => {
    const cat = catalog.data; if (!cat || slash || !canSlash) return;
    const sl = parseSlash(text); if (!sl) return;
    if (sl.hasSpace && !sl.rest) { const hit = cat.commands.find((c) => c.type === 1 && c.name === sl.name); if (hit) startSlash(hit); }
    else if (!sl.hasSpace) setSuggest(compute(text, ta.current?.selectionStart ?? text.length));
  }, [catalog.data]); // eslint-disable-line
  const clearDraft = () => { setDraft(cid, ''); saveDraft(useData.getState().me?.id, cid, ''); };
  const startSlash = (c: ApplicationCommand) => { setText(''); clearDraft(); setSuggest(null); setSlash(c); };
  const applySuggest = (s: NonNullable<Suggest>, i = s.index) => {
    const it = s.items[i]; if (!it) return;
    if (s.kind === 'command' && it.command) { startSlash(it.command); return; }
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

  const canTts = !secret && (!gid || can(perms, Perm.SEND_TTS));
  const send = async (gif?: string) => {
    const full = gif ?? finalize(text);
    if (!cs.canSend || (!full && !files.length)) return;
    const opts = gif ? { content: gif, flags: 0 } : parseSendOptions(full, { silent, noEmbeds, canTts });
    if ('ttsDenied' in opts && opts.ttsDenied) { toast(t('You do not have permission to use /tts here.'), 'error'); return; }
    if ('ttsEmpty' in opts && opts.ttsEmpty) { toast(t('Type a message after /tts.'), 'error'); return; }
    if (secret && opts.flags) { toast(t('Secret chats are text only: send options are not supported.'), 'error'); return; }
    const content = opts.content; const flags = opts.flags;
    if (!content && !files.length) return;
    if (slowLeft > 0) { toast(t('Slowmode is on: wait {s}s before sending again.', { s: slowLeft }), 'error'); return; }
    const warnCmd = !gif && channel.guildId ? parseWarnCommand(content, (n) => { const ms = Object.values(useData.getState().guilds[channel.guildId!]?.members ?? {}); const k = n.toLowerCase(); return ms.find((m) => m.user.username.toLowerCase() === k || m.nick?.toLowerCase() === k || m.user.displayName?.toLowerCase() === k)?.user.id; }) : null;
    if (warnCmd) { // /warn @member reason: a moderation action, never posted as a message
      if ('error' in warnCmd) { toast(warnCmd.error, 'error'); return; }
      try { await api.guilds.warn(channel.guildId!, warnCmd.userId, warnCmd.reason); toast(t('Warning added'), 'success'); setText(''); clearDraft(); tokens.current.clear(); setSuggest(null); } catch (e) { toastError(e); }
      return;
    }
    if (content.length > LIMITS.maxMessageLength) { toast(`Message is too long (${content.length}/${LIMITS.maxMessageLength}).`, 'error'); return; }
    const nonce = snowflake(); const toSend = files.map((f) => (f.spoiler && !f.file.name.startsWith('SPOILER_') ? new File([f.file], 'SPOILER_' + f.file.name, { type: f.file.type }) : f.file));
    const descriptions = files.map((f) => f.alt.trim() || null);
    const reply = replyId ?? null;
    useMessages.getState().addPending({ nonce, channelId: cid, content, files: toSend.map((f) => ({ name: f.name, size: f.size })), replyTo: reply, allowedMentions, flags, status: 'sending', createdAt: Date.now() });
    if (!gif) { setText(''); setFiles([]); clearDraft(); tokens.current.clear(); setSilent(false); setNoEmbeds(false); setAltOpen(null); }
    setPingReply(true); setReply(cid, null); setSuggest(null);
    if ((channel.slowmode ?? 0) > 0 && !slowBypass) setSlowUntil(Date.now() + channel.slowmode * 1000);
    const err = await (secret && me ? deliverSecret(nonce, channel, me.id, content, reply) : deliver(nonce, cid, content, toSend, reply, allowedMentions, flags, descriptions));
    if (err && (err as ApiException).status === 429 && (err as ApiException).code === 'SLOWMODE') { setSlowUntil(Date.now() + ((err as ApiException).retryAfterMs ?? 1000)); setNow(Date.now()); }
    else if (err && (channel.slowmode ?? 0) > 0) setSlowUntil(0); // a failed send does not start the timer
    const last = useMessages.getState().ch[cid]?.list.at(-1); if (last) ackLater(cid, last.id);
  };

  const sendSticker = async (stickerId: string) => {
    if (!cs.canSend) return;
    if (secret) { toast(t('Secret chats are text only: stickers are not supported.'), 'error'); return; }
    try { const msg = await api.messages.send(cid, { content: '', stickerIds: [stickerId] }); useMessages.getState().upsert(msg); useData.getState().apply('MESSAGE_CREATE', msg); ackLater(cid, msg.id); } catch (err) { toastError(err); }
  };

  // voice messages: hold the mic to record, release to preview, then send or discard
  const canVoice = cs.canSend && cs.canAttach && (!gid || can(perms, Perm.SEND_VOICE_MESSAGES));
  const clearVoiceState = () => { setRecording(false); setLive(null); };
  const startVoice = async () => {
    if (!canVoice || preview || recRef.current) return;
    // Just in time: the first press only asks for the microphone (explainer + OS prompt); recording needs a held press, so press again.
    const micState = await queryPermission('microphone');
    if (micState === 'prompt' || micState === 'denied') {
      if (await ensurePermission('microphone')) toast(t('Microphone allowed. Hold the button to record.'), 'success');
      return;
    }
    const rec = new VoiceRecorder((peaks, at) => setLive({ peaks, at }));
    recRef.current = rec;
    try { await rec.start(); } catch (err) { recRef.current = null; void reportPermissionFailure('microphone', err); return; }
    setLive({ peaks: [], at: 0 }); setRecording(true);
  };
  const stopVoice = async () => {
    const rec = recRef.current; if (!rec) return;
    recRef.current = null; clearVoiceState();
    const take = await rec.stop(); if (!take) return;
    setPreview({ file: take.file, peaks: take.peaks, duration: take.durationSec, url: URL.createObjectURL(take.file) });
  };
  const cancelVoice = () => { recRef.current?.cancel(); recRef.current = null; clearVoiceState(); };
  const discardVoice = () => { if (preview) URL.revokeObjectURL(preview.url); setPreview(null); };
  const sendVoice = async () => {
    const p = preview; if (!p || !cs.canSend) { discardVoice(); return; }
    const nonce = snowflake(); const reply = replyId ?? null;
    useMessages.getState().addPending({ nonce, channelId: cid, content: '', files: [{ name: p.file.name, size: p.file.size }], replyTo: reply, allowedMentions, status: 'sending', createdAt: Date.now() });
    URL.revokeObjectURL(p.url); setPreview(null); // the text draft stays: a voice message should not eat typed words
    setPingReply(true); setReply(cid, null); setSuggest(null);
    await deliver(nonce, cid, '', [p.file], reply, allowedMentions);
    const last = useMessages.getState().ch[cid]?.list.at(-1); if (last) ackLater(cid, last.id);
  };
  useEffect(() => () => { recRef.current?.cancel(); }, [cid]); // leaving the channel stops a live mic

  useEffect(() => {
    const h = async (e: Event) => {
      const nonce = (e as CustomEvent).detail as string; const p = useMessages.getState().pending.find((x) => x.nonce === nonce);
      if (!p || p.channelId !== cid) return;
      useMessages.getState().patchPending(nonce, { status: 'sending' });
      await (secret && me ? deliverSecret(nonce, channel, me.id, p.content, p.replyTo) : deliver(nonce, cid, p.content, [], p.replyTo, p.allowedMentions, p.flags));
    };
    window.addEventListener('jorcord:retry', h); return () => window.removeEventListener('jorcord:retry', h);
  }, [cid, channel, me, secret]);

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
    const sl = canSlash ? parseSlash(e.target.value) : null;
    // global commands have no gateway event: look again when someone starts a command and what we hold is a few seconds old
    if (sl && !sl.hasSpace && Date.now() - catalog.dataUpdatedAt > 3_000) void catalog.refetch();
    if (sl?.hasSpace && !sl.rest && catalogRef.current) { const hit = catalogRef.current.commands.find((c) => c.type === 1 && c.name === sl.name); if (hit) { startSlash(hit); return; } }
    setText(e.target.value); setSuggest(compute(e.target.value, e.target.selectionStart));
    if (e.target.value && cs.canSend) { const g = getGateway(); if (g.status === 'connected') g.sendTyping(cid); else throttledTyping(cid); }
  };
  const onPaste = (e: React.ClipboardEvent) => {
    const fs = [...e.clipboardData.files]; if (fs.length) { e.preventDefault(); addFiles(fs.map((f, i) => (f.name === 'image.png' ? new File([f], `pasted-${Date.now()}-${i}.png`, { type: f.type }) : f))); }
  };
  const insert = (s: string) => { const t = ta.current; const p = t?.selectionStart ?? text.length; setText(text.slice(0, p) + s + text.slice(p)); requestAnimationFrame(() => { t?.focus(); t?.setSelectionRange(p + s.length, p + s.length); }); };

  const canPoll = cs.canSend && !secret && (!gid || can(perms, Perm.SEND_POLLS)) && channel.type !== 'category';
  const over = text.length > LIMITS.maxMessageLength - 200;
  const canPostEmpty = files.length > 0; const hasText = text.trim().length > 0;
  const replyName = useMemo(() => (replyUser ? displayName(replyUser, gid ? guild?.members[replyUser.id] : undefined) : ''), [replyUser, gid, guild]);
  void users;

  return (
    <div className="relative shrink-0 px-4 pb-6 pt-0 max-md:pb-2" style={{ paddingBottom: mobile ? 'max(8px, var(--sab))' : undefined }}>
      {secret && <div className="-mx-4"><SecretBar channelId={cid} /></div>}
      {suggest && (
        <ul role="listbox" aria-label={t('Suggestions')} className="absolute inset-x-4 bottom-full z-30 mb-1 max-h-72 overflow-y-auto rounded-md bg-float p-2 shadow-elev">
          <li className="px-2 pb-1 text-xs font-bold uppercase text-muted">{suggest.kind === 'user' ? 'Members' : suggest.kind === 'channel' ? 'Channels' : suggest.kind === 'command' ? t('Commands') : 'Emoji'}</li>
          {suggest.items.map((it, i) => (
            <li key={it.key} role="option" aria-selected={i === suggest.index}>
              <button onMouseDown={(e) => { e.preventDefault(); applySuggest(suggest, i); }} onMouseEnter={() => setSuggest({ ...suggest, index: i })} className={cx('touch flex w-full items-center gap-2 rounded px-2 py-1 text-start md:min-h-[34px]', i === suggest.index ? 'bg-hover' : '')}>
                {it.avatar ? <Avatar user={it.avatar} size={24} /> : it.icon?.startsWith('http') || it.icon?.startsWith('/') ? <img loading="lazy" decoding="async" src={it.icon} alt="" className="h-6 w-6 object-contain" /> : <span className="flex h-6 w-6 items-center justify-center text-lg">{it.icon === '#' ? <Hash size={18} className="text-muted" /> : it.icon}</span>}
                <span className="font-medium text-header" style={{ color: it.color }}>{it.label}</span>{it.sub && <span className="min-w-0 flex-1 truncate text-sm text-muted">{it.sub}</span>}{it.app && <span className="ms-auto shrink-0 text-xs text-muted">{it.app}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className={cx('rounded-lg bg-[rgb(var(--composer))]', !cs.canSend && 'opacity-70')}>
        {replyId && (
          <div className="flex items-center justify-between rounded-t-lg bg-[rgb(var(--active)/0.6)] px-3 py-1.5 text-sm text-interactive">
            <span className="min-w-0 truncate">Replying to <b className="text-header">{replyName || '…'}</b>{replyMsg?.content && <span className="ms-2 text-muted">{toPlain(parseInline(replyMsg.content)).slice(0, 80)}</span>}</span>
            <span className="flex items-center gap-2">
              <button onClick={() => setPingReply(!pingReply)} aria-pressed={pingReply} className={cx('rounded px-1 text-xs font-bold', pingReply ? 'text-header' : 'text-muted')}>@ {pingReply ? 'ON' : 'OFF'}</button>
              <button aria-label={t('Cancel reply')} onClick={() => setReply(cid, null)}><X size={18} /></button>
            </span>
          </div>
        )}
        {files.length > 0 && (
          <ul className="flex gap-3 overflow-x-auto border-b border-divider/40 p-3" aria-label={t('Attachments to upload')}>
            {files.map((f) => (
              <li key={f.id} className="relative w-[140px] shrink-0 rounded-md bg-side p-2">
                <div className="flex h-[100px] items-center justify-center overflow-hidden rounded bg-rail">{f.preview ? <img src={f.preview} alt="" className={cx('max-h-full max-w-full object-contain', f.spoiler && 'blur-md')} /> : <ImageIcon size={32} className="text-muted" />}</div>
                <div className="mt-1 truncate text-xs text-header" title={f.file.name}>{f.file.name}</div><div className="text-[11px] text-muted">{fmtBytes(f.file.size)}</div>
                {altOpen === f.id && <textarea autoFocus value={f.alt} maxLength={1024} rows={3} aria-label={t('Alt text for {name}', { name: f.file.name })} placeholder={t('Describe this for people who cannot see it')} data-testid="alt-input"
                  onChange={(e) => setFiles((c) => c.map((x) => (x.id === f.id ? { ...x, alt: e.target.value } : x)))} onKeyDown={(e) => { if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); e.stopPropagation(); setAltOpen(null); } }} className="mt-1 w-full resize-none rounded bg-input p-1 text-xs text-normal outline-none" />}
                <div className="absolute end-1 top-1 flex gap-0.5 rounded bg-chat/90 p-0.5">
                  <button aria-label={f.alt ? t('Edit alt text') : t('Add alt text')} aria-pressed={!!f.alt} data-testid="alt-toggle" onClick={() => setAltOpen(altOpen === f.id ? null : f.id)} className={cx('px-1 text-[10px] font-extrabold leading-[22px]', f.alt ? 'text-brand' : 'text-interactive hover:text-header')}>ALT</button>
                  <button aria-label={f.spoiler ? 'Remove spoiler' : 'Mark as spoiler'} aria-pressed={f.spoiler} onClick={() => setFiles((c) => c.map((x) => (x.id === f.id ? { ...x, spoiler: !x.spoiler } : x)))} className="p-1 text-interactive hover:text-header">{f.spoiler ? <EyeOff size={14} /> : <Eye size={14} />}</button>
                  <button aria-label={t('Remove attachment')} onClick={() => setFiles((c) => c.filter((x) => x.id !== f.id))} className="p-1 text-danger"><X size={14} /></button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {recording && (
          <div className="flex items-center justify-between rounded-t-lg bg-[rgb(var(--active)/0.6)] px-3 py-1.5 text-sm text-interactive" data-testid="voice-recording">
            <span className="flex shrink-0 items-center gap-2"><span className="h-2 w-2 animate-pulse rounded-full bg-danger" data-testid="voice-recording-dot" /><b className="tabular-nums">{fmtVoiceDuration((live?.at ?? 0) / 1000)}</b></span>
            <span className="min-w-0 flex-1 px-3"><WaveformBars peaks={waveformPeaks(live?.peaks ?? [], 24)} progress={1} /></span>
            <button aria-label={t('Cancel recording')} data-testid="voice-cancel" onClick={cancelVoice} className="shrink-0 text-interactive hover:text-header"><X size={18} /></button>
          </div>
        )}
        {preview && !recording && (
          <div className="flex items-center gap-2 rounded-t-lg bg-[rgb(var(--active)/0.6)] p-2 pe-3 text-sm text-interactive" data-testid="voice-preview">
            <VoicePlayer src={preview.url} durationHint={preview.duration} />
            <button aria-label={t('Discard voice message')} data-testid="voice-discard" onClick={discardVoice} className="ml-0.5 shrink-0 text-interactive hover:text-header"><X size={18} /></button>
            <button aria-label={t('Send voice message')} data-testid="voice-send" onClick={() => void sendVoice()} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand text-white"><SendHorizonal size={18} /></button>
          </div>
        )}
        {slash && <SlashForm key={slash.id} channel={channel} command={slash} appName={catalog.data?.applications.find((a) => a.id === slash.applicationId)?.name} onDone={() => { setSlash(null); requestAnimationFrame(() => ta.current?.focus()); }} />}
        <div className={cx('flex items-end', slash && 'hidden')}>
          <button aria-label={t('Attach')} aria-haspopup="menu" disabled={!cs.canSend} onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openMenu(r.left, r.top - (canPoll ? 96 : 52), [
              { label: t('Upload a File'), icon: Upload, disabled: !cs.canAttach, onClick: () => fileInput.current?.click() },
              ...(canPoll ? [{ label: t('Create Poll'), icon: BarChart3, onClick: () => openModal({ kind: 'createPoll', channelId: cid }) }] : []),
            ]);
          }} className="flex h-11 w-11 shrink-0 items-center justify-center text-interactive hover:text-interactive-hover disabled:cursor-not-allowed disabled:opacity-40"><PlusCircle size={24} /></button>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
          {canVoice && (
            <button aria-label={t('Hold to record a voice message')} data-testid="voice-mic" disabled={!!preview}
              onPointerDown={(e) => { e.preventDefault(); try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* pointer already gone */ } void startVoice(); }}
              onPointerUp={() => { void stopVoice(); }} onPointerCancel={cancelVoice}
              className={cx('flex h-11 w-11 shrink-0 items-center justify-center', recording ? 'text-danger' : 'text-interactive hover:text-interactive-hover', preview && 'opacity-40')}><Mic size={24} /></button>
          )}
          <textarea ref={ta} value={text} rows={1} disabled={!cs.canSend} placeholder={placeholder} aria-label={placeholder} enterKeyHint={mobile ? 'enter' : 'send'} onChange={onChange} onKeyDown={onKey} onPaste={onPaste} onFocus={() => { if (canSlash && Date.now() - catalog.dataUpdatedAt > 10_000) void catalog.refetch(); }} onBlur={() => setTimeout(() => setSuggest(null), 100)}
            className="max-h-[45vh] min-h-[44px] flex-1 resize-none bg-transparent py-[11px] text-[16px] leading-[22px] text-normal outline-none placeholder:text-muted disabled:cursor-not-allowed" />
          {over && <span className={cx('self-center pe-2 text-xs font-semibold', text.length > LIMITS.maxMessageLength ? 'text-danger' : 'text-muted')}>{LIMITS.maxMessageLength - text.length}</span>}
          <button aria-label={t('Choose emoji or GIF')} disabled={!cs.canSend} onClick={(e) => openPopout({ kind: 'emoji', rect: e.currentTarget.getBoundingClientRect(), guildId: gid ?? undefined, stickers: true, externalStickers: !gid || can(perms, Perm.USE_EXTERNAL_STICKERS), onPick: (p) => { if (p.sticker) void sendSticker(p.sticker); else if ((p as any).gif) send((p as any).gif); else if (p.char) insert(p.char); else if (p.id) { tokens.current.set(`:${p.name}:`, `<${p.animated ? 'a' : ''}:${p.name}:${p.id}>`); insert(`:${p.name}: `); } } })} className="flex h-11 w-11 shrink-0 items-center justify-center text-interactive hover:text-interactive-hover disabled:opacity-40"><Smile size={24} /></button>
          <button aria-label={t('Open GIF picker')} data-testid="composer-gif" disabled={!cs.canSend} onClick={(e) => openPopout({ kind: 'emoji', gifOnly: true, rect: e.currentTarget.getBoundingClientRect(), guildId: gid ?? undefined, onPick: (p) => { if ((p as any).gif) void send((p as any).gif); } })} className="flex h-11 w-9 shrink-0 items-center justify-center text-interactive hover:text-interactive-hover disabled:opacity-40"><span aria-hidden className="rounded border-2 border-current px-0.5 text-[10px] font-extrabold leading-[14px]">GIF</span></button>
          {slowLeft > 0 && <span role="timer" aria-live="off" aria-label={t('Slowmode: {s} seconds left', { s: slowLeft })} data-testid="slowmode-countdown" className="flex shrink-0 items-center gap-1 self-center rounded-full bg-[rgb(var(--active))] px-2 py-0.5 text-xs font-semibold tabular-nums text-interactive"><Timer size={13} aria-hidden />{fmtSlowmode(slowLeft)}</span>}
          {cs.canSend && !secret && (hasText || files.length > 0) && <>
            <button aria-label={t('Send silently')} aria-pressed={silent} title={t('Send silently (no notifications)')} data-testid="composer-silent" onClick={() => setSilent(!silent)} className={cx('flex h-11 w-9 shrink-0 items-center justify-center', silent ? 'text-brand' : 'text-interactive hover:text-interactive-hover')}><BellOff size={20} /></button>
            <button aria-label={t('Do not embed links')} aria-pressed={noEmbeds} title={t('Do not embed links')} data-testid="composer-noembeds" onClick={() => setNoEmbeds(!noEmbeds)} className={cx('flex h-11 w-9 shrink-0 items-center justify-center', noEmbeds ? 'text-brand' : 'text-interactive hover:text-interactive-hover')}><Link2Off size={20} /></button>
          </>}
          {(hasText || files.length > 0) && cs.canSend && !secret && !text.startsWith('/') && text.length <= LIMITS.maxMessageLength && <button aria-label={t('Schedule message')} title={t('Send later')} data-testid="composer-schedule" onClick={() => openModal({ kind: 'scheduleMessage', channelId: cid, content: hasText ? finalize(text) : '', replyTo: replyId ?? null, files: files.map((f) => (f.spoiler && !f.file.name.startsWith('SPOILER_') ? new File([f.file], 'SPOILER_' + f.file.name, { type: f.file.type }) : f.file)), onDone: () => { setText(''); setFiles([]); clearDraft(); tokens.current.clear(); setReply(cid, null); setSuggest(null); } })} className="flex h-11 w-9 shrink-0 items-center justify-center text-interactive hover:text-interactive-hover"><CalendarClock size={20} /></button>}
          {mobile && (hasText || canPostEmpty) && <button aria-label={t('Send message')} disabled={slowLeft > 0} onClick={() => send()} className="m-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand text-white disabled:opacity-40"><SendHorizonal size={18} /></button>}
          {!mobile && <span className="hidden"><Gift size={0} /></span>}
        </div>
      </div>
    </div>
  );
}

const lastTyping = new Map<string, number>();
function throttledTyping(cid: string) { const n = Date.now(); if ((lastTyping.get(cid) ?? 0) + 8000 > n) return; lastTyping.set(cid, n); api.channels.typing(cid).catch(() => {}); }

/** Secret chat send: encrypted here, on this device. Blocks (and opens the safety number dialog) when the other person's keys changed. */
async function deliverSecret(nonce: string, channel: Channel, meId: string, content: string, reply: string | null) {
  const st = useMessages.getState();
  try {
    const msg = await sendSecretMessage(channel, { id: meId }, content, reply);
    useSecret.setState((s) => ({ opened: { ...s.opened, [msg.id]: { ok: true, text: content } } })); // we just wrote it: no need to decrypt our own message
    st.upsert(msg); st.dropPending(nonce);
    useData.getState().apply('MESSAGE_CREATE', msg);
    void useSecret.getState().load(channel, meId, true);
  } catch (e) {
    st.patchPending(nonce, { status: 'failed' });
    if (e instanceof SecretChatError && e.code === 'KEY_CHANGED') useUI.getState().openModal({ kind: 'safetyNumber', channelId: channel.id });
    toastError(e);
  }
}

/** Sends and settles the pending entry. Returns the error (also toasted) so the caller can react, e.g. to a slowmode 429. */
async function deliver(nonce: string, cid: string, content: string, files: File[], reply: string | null, allowedMentions?: AllowedMentions | null, flags?: number, descriptions?: (string | null)[]): Promise<unknown> {
  const st = useMessages.getState();
  try {
    const msg = await api.messages.send(cid, { content, files, replyTo: reply, nonce, allowedMentions, flags, descriptions });
    st.upsert(msg); st.dropPending(nonce);
    useData.getState().apply('MESSAGE_CREATE', msg);
    return null;
  } catch (e) { st.patchPending(nonce, { status: 'failed' }); toastError(e); return e; }
}
