import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Megaphone, CornerUpLeft, Hash, LogIn, MoreHorizontal, Pencil, Pin, Reply, SmilePlus, Trash2, Rocket, Phone, MessagesSquare, AlertCircle, RotateCw } from 'lucide-react';
import type { Message } from '@jorcord/shared';
import { MessageFlags, Perm, isStandardStickerId, standardSticker } from '@jorcord/shared';
import { useTranslations } from '@/lib/translate';
import { Avatar } from '@/components/ui/Avatar';
import { ServerTagBadge } from '@/components/ui/Cosmetics';
import { Markdown } from './Markdown';
import { LinkWarningBanner } from '@/components/ui/TrustBits';
import { MessageText } from './SecretChat';
import { AttachmentView, EmbedView } from './Attachments';
import { Forward as ForwardIcon } from 'lucide-react';
import { ReactionBar, addReaction } from './Reactions';
import { StickerImage } from './StickerImage';
import { useData, refreshStickers } from '@/stores/data';
import { useUI, toast, toastError } from '@/stores/ui';
import { useMessages, type Pending } from '@/stores/messages';
import { api } from '@/lib/api';
import { cx, displayName, fmtFull, fmtStamp, fmtTime, msgTime, fileUrl } from '@/lib/format';
import { roleColor, roleNameStyle, roleIcon, canEditMessage, canDeleteMessage, canPinMessage, can } from '@/lib/perms';
import { RoleIcon } from '@/components/ui/RoleIcon';
import { t } from '@/i18n';
import { toPlain, parseInline } from '@/lib/markdown';
import { messageMenu, userMenu } from '@/lib/menus';
import { useMenuTrigger } from '@/components/ui/ContextMenu';
import { myChannelPerms } from '@/lib/session';
import { useNav } from '@/lib/nav';
import { useIsMobile } from '@/lib/hooks';
import { Tip } from '@/components/ui/Tooltip';
import { boostAnnouncement } from '@/lib/boosts';
import { ComponentsV2, isComponentsV2 } from './ComponentsV2';
import { EphemeralNotice, InteractionHeader, MessageComponents, PollResultBody, PollView, ThinkingBody, isLoadingMsg } from './MessageExtras';
import { isEphemeral } from '@/stores/messages';
import { nameStyleClass } from '@/lib/nameStyle';
import { withIgnore } from './IgnoredStub';
import { WaveButton, ttlSystemText } from './JoinExtras';

const SYSTEM: Record<string, (n: string) => string> = {
  join: () => t('just joined the server. Say hi!'), pin: () => t('pinned a message to this channel.'), boost: () => t('just boosted the server!'),
  thread_created: () => t('started a thread.'), call: () => t('started a call.'), ttl_update: () => '',
};

export function useAuthorInfo(m: Pick<Message, 'author' | 'guildId'>) {
  const member = useData((s) => (m.guildId ? s.guilds[m.guildId]?.members[m.author.id] : undefined));
  const roles = useData((s) => (m.guildId ? s.guilds[m.guildId]?.roles : undefined));
  const live = useData((s) => s.users[m.author.id]);
  const user = useMemo(() => ({ ...m.author, ...live }), [m.author, live]);
  return useMemo(() => {
    const roleList = roles ? Object.values(roles) : undefined;
    return { user, member, name: displayName(user, member), color: member && roleList ? roleColor(member, roleList) : undefined, nameStyle: member && roleList ? roleNameStyle(member, roleList) : undefined, icon: member && roleList ? roleIcon(member, roleList) : undefined };
  }, [user, member, roles]);
}

function ReplyPreview({ m }: { m: Message }) {
  const ref = m.referenced; const open = useUI((s) => s.openPopout);
  const info = useAuthorInfo(ref ?? { author: m.author, guildId: m.guildId });
  if (!m.replyTo) return null;
  const jump = () => window.dispatchEvent(new CustomEvent('jorcord:jump', { detail: { channelId: m.channelId, messageId: m.replyTo } }));
  return (
    <div className="relative mb-0.5 ms-[56px] flex items-center gap-1.5 pe-4 text-sm text-muted before:absolute before:-start-[36px] before:top-1/2 before:h-2.5 before:w-[30px] before:rounded-ss-md before:border-s-2 before:border-t-2 before:border-[rgb(var(--active))] before:content-['']" style={{ marginTop: 4 }}>
      {ref ? (
        <>
          <Avatar user={info.user} size={16} />
          <button className="shrink-0 font-medium hover:underline" style={info.nameStyle ?? { color: info.color }} onClick={(e) => open({ kind: 'user', userId: ref.author.id, guildId: m.guildId ?? undefined, rect: e.currentTarget.getBoundingClientRect() })}>@{info.name}</button>
          <button onClick={jump} className="min-w-0 flex-1 truncate text-start text-interactive hover:text-header">{ref.content.startsWith('jc-e2ee1:') ? t('Encrypted message') : ref.content ? toPlain(parseInline(ref.content)) : ref.attachments.length ? 'Click to see attachment' : 'Message'}</button>
        </>
      ) : <button onClick={jump} className="italic">Original message was deleted</button>}
    </div>
  );
}

function Editor({ m, done }: { m: Message; done: () => void }) {
  const [v, setV] = useState(m.content); const [busy, setBusy] = useState(false); const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const t = ref.current; if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; } }, []);
  const save = async () => {
    const c = v.trim(); if (c === m.content) return done();
    if (!c && !m.attachments.length) return;
    setBusy(true);
    try { const u = await api.messages.edit(m.channelId, m.id, c); useMessages.getState().update({ ...m, ...u, content: c, editedAt: u?.editedAt ?? new Date().toISOString() }); done(); } catch (e) { toastError(e); setBusy(false); }
  };
  return (
    <div className="pe-4">
      <textarea ref={ref} value={v} disabled={busy} aria-label="Edit message" rows={1} onChange={(e) => { setV(e.target.value); e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; }}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); } if (e.key === 'Escape') { e.stopPropagation(); done(); } }}
        className="max-h-[50vh] w-full resize-none rounded-lg bg-[rgb(var(--composer))] px-3 py-2.5 text-normal outline-none" />
      <div className="mt-1 text-xs text-muted">escape to <button className="text-link hover:underline" onClick={done}>cancel</button> • enter to <button className="text-link hover:underline" onClick={save}>save</button></div>
    </div>
  );
}

function Toolbar({ m, onMenu, startEdit }: { m: Message; onMenu: (e: React.MouseEvent) => void; startEdit: () => void }) {
  const me = useData((s) => s.me); const setReply = useUI((s) => s.setReply); const openPopout = useUI((s) => s.openPopout); const openModal = useUI((s) => s.openModal);
  if (!me) return null;
  const perms = myChannelPerms(m.channelId); const isDm = !m.guildId;
  const react = can(perms, Perm.ADD_REACTIONS) || isDm; const send = can(perms, Perm.SEND_MESSAGES) || isDm;
  const mine = canEditMessage(m, me.id);
  const B = ({ label, onClick, children, danger }: { label: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; children: React.ReactNode; danger?: boolean }) => (
    <Tip text={label} side="top"><button aria-label={label} onClick={onClick} className={cx('flex h-8 w-8 items-center justify-center rounded text-interactive hover:bg-hover', danger ? 'hover:text-danger' : 'hover:text-interactive-hover')}>{children}</button></Tip>
  );
  return (
    <div role="toolbar" aria-label="Message actions" className="absolute -top-4 end-4 z-10 hidden items-center rounded-md border border-divider/50 bg-chat shadow-high group-focus-within/msg:flex group-hover/msg:flex">
      {react && <B label="Add Reaction" onClick={(e) => openPopout({ kind: 'emoji', rect: e.currentTarget.getBoundingClientRect(), guildId: m.guildId ?? undefined, allowBurst: true, onPick: (p) => addReaction(m, p) })}><SmilePlus size={20} /></B>}
      {mine ? <B label="Edit" onClick={startEdit}><Pencil size={18} /></B> : send ? <B label="Reply" onClick={() => setReply(m.channelId, m.id)}><Reply size={20} /></B> : null}
      {mine && send && <B label="Reply" onClick={() => setReply(m.channelId, m.id)}><Reply size={20} /></B>}
      {m.guildId && !(m.flags && (m.flags & 1)) && !(m.flags && (m.flags & 2)) && (m.type === 'default' || m.type === 'reply') && useData.getState().guilds[m.guildId]?.channels[m.channelId]?.type === 'announcement' && (mine || can(perms, Perm.MANAGE_MESSAGES)) && <B label="Publish" onClick={() => api.channels.crosspost(m.channelId, m.id).then((u) => { useMessages.getState().update(u); toast('Published to followers', 'success'); }).catch(toastError)}><Megaphone size={18} /></B>}
      {canPinMessage(perms, isDm) && <B label={m.pinned ? 'Unpin' : 'Pin'} onClick={() => (m.pinned ? api.messages.unpin : api.messages.pin)(m.channelId, m.id).then(() => useMessages.getState().update({ ...m, pinned: !m.pinned })).catch(toastError)}><Pin size={18} className={m.pinned ? 'fill-current' : ''} /></B>}
      {canDeleteMessage(m, me.id, perms) && <B danger label="Delete" onClick={() => openModal({ kind: 'confirm', title: 'Delete Message', body: 'Are you sure you want to delete this message?', confirmLabel: 'Delete', danger: true, onConfirm: () => api.messages.delete(m.channelId, m.id).then(() => useMessages.getState().remove(m.channelId, m.id)).catch(toastError) })}><Trash2 size={18} /></B>}
      <B label="More" onClick={onMenu}><MoreHorizontal size={20} /></B>
    </div>
  );
}

/** The translated text of a message ("Translate" in its menu), shown under the original. */
function TranslationBlock({ id }: { id: string }) {
  const tr = useTranslations((s) => s.by[id]);
  if (!tr) return null;
  if (tr === 'loading') return <div className="mt-1 text-xs text-muted" role="status" data-testid="translation-loading">{t('Translating…')}</div>;
  return (
    <div className="mt-1 rounded border-s-2 border-divider ps-2 text-[15px] text-normal" data-testid="translation">
      <div className="whitespace-pre-wrap">{tr.text}</div>
      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted"><span>{tr.via === 'browser' ? t('Translated on this device') : t('Translated by the server')}</span><button className="underline hover:text-header" onClick={() => useTranslations.getState().set(id, null)}>{t('Hide translation')}</button></div>
    </div>
  );
}

const MessageItemBase = memo(function MessageItem({ m, grouped, highlighted, onEditHistory }: { m: Message; grouped: boolean; highlighted?: boolean; /** R19: clicking "(edited)" opens the prior-version popover owned by the message list. */ onEditHistory?: (m: Message, rect: DOMRect) => void }) {
  const me = useData((s) => s.me); const info = useAuthorInfo(m); const guildName = useData((s) => (m.guildId ? s.guilds[m.guildId]?.guild.name : undefined));
  const editing = useUI((s) => s.editing === m.id); const setEditing = useUI((s) => s.setEditing); const openPopout = useUI((s) => s.openPopout); const openMenu = useUI((s) => s.openMenu);
  const replyingTo = useUI((s) => s.replyTo[m.channelId] === m.id);
  const nav = useNav(); const mobile = useIsMobile();
  const ts = msgTime(m.id, m.createdAt);
  // Stickers may belong to another server the viewer is in (USE_EXTERNAL_STICKERS), so look through every known guild, own first.
  const allStickers = useData((s) => (m.stickerIds.length && m.guildId ? s.guilds[m.guildId]?.stickers : undefined));
  const order = useData((s) => (m.stickerIds.length ? s.guildOrder : undefined)); const guildsMap = useData((s) => (m.stickerIds.length ? s.guilds : undefined));
  const externalStickers = useMemo(() => (order && guildsMap && m.guildId ? order.filter((id) => id !== m.guildId).flatMap((id) => guildsMap[id]?.stickers ?? []) : undefined), [order, guildsMap, m.guildId]);
  const standard = m.stickerIds.map((id) => standardSticker(id)).filter((x): x is NonNullable<typeof x> => !!x);
  const ownIds = m.stickerIds.filter((id) => !isStandardStickerId(id));
  const own = allStickers || externalStickers ? ownIds.map((id) => allStickers?.find((x) => x.id === id) ?? externalStickers?.find((x) => x.id === id)).filter((x): x is NonNullable<typeof x> => !!x) : undefined;
  const stickers = m.stickerIds.length ? [...standard, ...(own ?? [])] : undefined;
  useEffect(() => { if (m.guildId && ownIds.length && (own?.length ?? 0) < ownIds.length) void refreshStickers(m.guildId); }, [m.guildId, ownIds.length, own?.length]); // eslint-disable-line
  const mentioned = !!me && (m.mentions.includes(me.id) || m.mentionEveryone) && m.author.id !== me.id;
  const startEdit = () => setEditing(m.id);
  const canSeeHistory = !!me && (m.author.id === me.id || (!!m.guildId && can(myChannelPerms(m.channelId), Perm.MANAGE_MESSAGES))); // the server only gives edit history to the author and moderators
  const sensitive = ((m.flags ?? 0) & MessageFlags.SENSITIVE) !== 0; const [shown, setShown] = useState(false);
  const ephemeral = isEphemeral(m);
  const menuItems = () => ephemeral ? [{ label: t('Dismiss message'), onClick: () => useMessages.getState().remove(m.channelId, m.id) }] : messageMenu(m, { startEdit, pickEmoji: () => openPopout({ kind: 'emoji', rect: new DOMRect(window.innerWidth / 2, window.innerHeight / 2, 0, 0), guildId: m.guildId ?? undefined, allowBurst: true, onPick: (p) => addReaction(m, p) }) });
  const trig = useMenuTrigger(menuItems);
  const userTrig = useMenuTrigger(() => userMenu(m.author.id, m.guildId));
  const openUser = (e: React.MouseEvent) => { e.stopPropagation(); openPopout({ kind: 'user', userId: m.author.id, guildId: m.guildId ?? undefined, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() }); };

  const sys = !!SYSTEM[m.type];
  const base = cx('group/msg relative px-4 hover:bg-chat-hover focus-within:bg-chat-hover', mentioned && 'bg-warn/10 hover:bg-warn/[0.14] before:absolute before:inset-y-0 before:start-0 before:w-0.5 before:bg-warn', replyingTo && 'bg-brand/10 before:absolute before:inset-y-0 before:start-0 before:w-0.5 before:bg-brand', highlighted && 'flash');
  if (sys) {
    const Icon = m.type === 'join' ? LogIn : m.type === 'pin' ? Pin : m.type === 'boost' ? Rocket : m.type === 'call' ? Phone : MessagesSquare;
    return (
      <div className={cx(base, 'flex items-center gap-3 py-1.5')} {...trig} id={`msg-${m.id}`}>
        <span className="flex w-10 justify-end"><Icon size={18} className={m.type === 'join' ? 'text-success' : 'text-muted'} /></span>
        <span className="text-[15px] text-muted"><button className="font-medium text-header hover:underline" onClick={openUser}>{info.name}</button> {m.type === 'boost' ? t(boostAnnouncement(m.content, guildName)) : m.type === 'call' && m.content === 'missed' ? (m.author.id === me?.id ? t('called, but no one picked up.') : t('called, but you missed it.')) : m.type === 'ttl_update' ? ttlSystemText(m.content) : SYSTEM[m.type]('').trim()} <span className="ms-1 whitespace-nowrap text-xs">{fmtStamp(ts)}</span>{m.type === 'join' && <WaveButton m={m} />}</span>
      </div>
    );
  }
  const inner = (
    <>
      {isLoadingMsg(m) ? <ThinkingBody m={m} /> : m.type === 'poll_result' ? <PollResultBody m={m} /> : editing ? <Editor m={m} done={() => setEditing(null)} /> : m.content ? (
        <div className="relative pe-4 text-[16px] leading-[1.375rem] text-normal">
          <MessageText m={m} guildId={m.guildId} />
          {m.editedAt && (onEditHistory && canSeeHistory
            ? <button data-testid="edit-history-trigger" className="ms-1 cursor-pointer select-none text-[10px] text-muted hover:text-interactive-hover" title={fmtFull(new Date(m.editedAt).getTime())} onClick={(e) => { e.stopPropagation(); onEditHistory(m, e.currentTarget.getBoundingClientRect()); }}>(edited)</button>
            : <time className="ms-1 select-none text-[10px] text-muted" title={fmtFull(new Date(m.editedAt).getTime())}>(edited)</time>)}
        </div>
      ) : null}
      {!editing && <LinkWarningBanner warnings={m.linkWarnings} />}
      {m.forward && <ForwardedBody f={m.forward} guildId={m.guildId} />}
      {m.attachments.length > 0 && <div className="mt-1 flex flex-col items-start gap-1">{m.attachments.map((a) => <AttachmentView key={a.id} a={a} />)}</div>}
      {stickers && stickers.length > 0 && <div className="mt-1 flex gap-2">{stickers.map((s) => <StickerImage key={s.id} sticker={s} className="h-[160px] w-[160px] object-contain" />)}</div>}
      {m.embeds.length > 0 && !((m.flags ?? 0) & MessageFlags.SUPPRESS_EMBEDS) && <div className="mt-1 flex flex-col items-start gap-1">{m.embeds.map((e, i) => <EmbedView key={i} e={e} />)}</div>}
      <TranslationBlock id={m.id} />
      {!!m.flags && !!(m.flags & 1) && <div className="mt-0.5 flex items-center gap-1 text-[11px] font-medium text-muted" data-testid="published-mark"><Megaphone size={11} aria-hidden />{t('Published')}</div>}
      {m.crosspost && <div className="mt-0.5 flex items-center gap-1 text-[11px] font-medium text-muted" data-testid="crosspost-origin"><Megaphone size={11} aria-hidden />{t('Followed from')} {m.crosspost.guildName} · #{m.crosspost.channelName}</div>}
      {m.pinned && <div className="mt-0.5 flex items-center gap-1 text-[11px] font-medium text-muted" data-testid="pinned-mark"><Pin size={11} aria-hidden />{t('Pinned')}</div>}
      {m.poll && <PollView m={m} />}
      {!!m.components?.length && !isLoadingMsg(m) && (isComponentsV2(m) ? <ComponentsV2 m={m} /> : <MessageComponents m={m} />)}
      {ephemeral && <EphemeralNotice m={m} />}
      {!ephemeral && <ReactionBar m={m} />}
      {m.threadId && <button onClick={() => nav.go(m.guildId, m.threadId)} className="mt-1 flex items-center gap-1.5 rounded border border-divider bg-side px-2 py-1 text-sm text-link hover:underline"><MessagesSquare size={14} />View thread</button>}
    </>
  );
  const body = sensitive && !shown && !editing ? (
    <div className="relative" data-testid="sensitive-wrap">
      <div className="pointer-events-none select-none blur-md" aria-hidden>{inner}</div>
      <button type="button" data-testid="sensitive-reveal" className="absolute inset-0 flex items-center justify-center rounded bg-black/20 text-sm font-semibold text-white" onClick={(e) => { e.stopPropagation(); setShown(true); }}>{t('Sensitive content. Click to show')}</button>
    </div>
  ) : (<>{sensitive && <div className="mb-0.5 text-[11px] font-medium text-warn" data-testid="sensitive-mark">{t('Marked sensitive')}</div>}{inner}</>);
  void nav; void mobile; void Hash; void CornerUpLeft; void fileUrl;
  return (
    <div className={cx(base, 'msg-cozy', !grouped && !m.replyTo && !m.interaction ? 'mt-[17px] pt-[2px]' : m.replyTo || m.interaction ? 'mt-[17px]' : '', ephemeral && 'bg-brand/[0.06]')} id={`msg-${m.id}`} data-mid={m.id} {...trig} onDoubleClick={() => { if (me && canEditMessage(m, me.id) && !mobile) startEdit(); }}>
      {m.replyTo && <ReplyPreview m={m} />}
      {m.interaction && !m.replyTo && <InteractionHeader m={m} />}
      <div className="relative flex gap-4 pb-[2px]">
        {grouped && !m.replyTo && !m.interaction ? (
          <time dateTime={new Date(ts).toISOString()} title={fmtFull(ts)} className="mt-[3px] w-10 shrink-0 select-none whitespace-nowrap text-end text-[10px] leading-[1.375rem] text-muted opacity-0 group-hover/msg:opacity-100">{fmtTime(ts)}</time>
        ) : (
          <button onClick={openUser} {...userTrig} aria-label={`${info.name} profile`} className="mt-0.5 h-10 w-10 shrink-0"><Avatar user={info.user} size={40} memberAvatar={info.member?.avatar} className="hover:opacity-90" /></button>
        )}
        <div className="min-w-0 flex-1">
          {(!grouped || m.replyTo || m.interaction) && (
            <div className="flex items-baseline gap-2 leading-[1.375rem]">
              <button onClick={openUser} {...userTrig} className={`truncate font-medium text-header hover:underline ${nameStyleClass(info.user.displayNameStyle)}`} style={info.nameStyle ?? { color: info.color }}>{info.name}</button><ServerTagBadge tag={info.user.serverTag} className="ms-1 align-middle" />
              {info.icon && <RoleIcon role={info.icon} size={16} className="self-center" />}
              {m.author.bot && <span className="self-center rounded bg-brand px-1 py-px text-[10px] font-bold uppercase leading-3 text-white">Bot</span>}
              <time dateTime={new Date(ts).toISOString()} title={fmtFull(ts)} className="text-xs font-medium text-muted">{fmtStamp(ts)}</time>
            </div>
          )}
          {body}
        </div>
      </div>
      {!editing && !ephemeral && <Toolbar m={m} startEdit={startEdit} onMenu={(e) => { const r = e.currentTarget.getBoundingClientRect(); openMenu(r.left - 200, r.bottom + 4, menuItems()); }} />}
    </div>
  );
});

export function PendingItem({ p, grouped }: { p: Pending; grouped: boolean }) {
  const me = useData((s) => s.me);
  const drop = () => useMessages.getState().dropPending(p.nonce);
  const retry = () => window.dispatchEvent(new CustomEvent('jorcord:retry', { detail: p.nonce }));
  if (!me) return null;
  return (
    <div className={cx('relative flex gap-4 px-4 pb-0.5', !grouped && 'mt-[17px]', p.status === 'sending' && 'opacity-60')} aria-busy={p.status === 'sending'}>
      {grouped ? <span className="w-10 shrink-0" /> : <Avatar user={me} size={40} />}
      <div className="min-w-0 flex-1">
        {!grouped && <div className="font-medium text-header">{displayName(me)}</div>}
        {p.content && <div className={cx('text-[16px]', p.status === 'failed' && 'text-danger')}><Markdown content={p.content} /></div>}
        {p.files.map((f) => <div key={f.name} className="mt-1 text-xs text-muted">📎 {f.name}</div>)}
        {p.status === 'failed' && <div className="mt-1 flex items-center gap-2 text-sm text-danger"><AlertCircle size={14} />Failed to send. <button className="flex items-center gap-1 underline" onClick={retry}><RotateCw size={12} />Retry</button> <button className="underline" onClick={drop}>Delete</button></div>}
      </div>
    </div>
  );
}

/** Snapshot of a forwarded message: quoted block, original time, and a jump link when the origin is known to this client. */
function ForwardedBody({ f, guildId }: { f: NonNullable<Message['forward']>; guildId: string | null }) {
  const src = useData((s) => (f.sourceGuildId ? s.guilds[f.sourceGuildId]?.channels[f.sourceChannelId] : s.dms[f.sourceChannelId]));
  const nav = useNav();
  return (
    <div data-testid="forwarded" className="mt-1 max-w-[520px] rounded border-s-4 border-muted/50 bg-side/60 py-1 pe-3 ps-3">
      <div className="mb-0.5 flex items-center gap-1 text-xs italic text-muted"><ForwardIcon size={12} aria-hidden />{t('Forwarded')}</div>
      {f.content && <div className="text-[16px] leading-[1.375rem] text-normal"><Markdown content={f.content} guildId={f.sourceGuildId ?? guildId} /></div>}
      {f.attachments.length > 0 && <div className="mt-1 flex flex-col items-start gap-1">{f.attachments.map((a) => <AttachmentView key={a.id} a={a} />)}</div>}
      {f.embeds.length > 0 && <div className="mt-1 flex flex-col items-start gap-1">{f.embeds.map((e, i) => <EmbedView key={i} e={e} />)}</div>}
      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted"><time>{fmtStamp(new Date(f.createdAt).getTime())}</time>
        {src && <button className="hover:underline" onClick={() => { nav.go(f.sourceGuildId ?? '@me', f.sourceChannelId); setTimeout(() => window.dispatchEvent(new CustomEvent('jorcord:jump', { detail: { channelId: f.sourceChannelId, messageId: f.sourceMessageId } })), 400); }}>{src.name ? `#${src.name}` : t('Original')}</button>}</div>
    </div>
  );
}

/** Messages from people I ignore fold into a one-line stub (components/chat/IgnoredStub.tsx). */
export const MessageItem = withIgnore(MessageItemBase);
