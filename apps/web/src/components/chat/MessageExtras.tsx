/** Rendering for the platform-pass message features: interaction headers, ephemeral notices, "thinking" placeholders, components, polls. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, Check, ChevronDown, ExternalLink, EyeOff, Loader2 } from 'lucide-react';
import { ButtonStyle, ComponentType as CT, MessageFlags, Perm } from '@jorcord/shared';
import type { Component, Message, SelectOption } from '@jorcord/shared';
import { useData } from '@/stores/data';
import { useUI, toastError } from '@/stores/ui';
import { useMessages, isEphemeral } from '@/stores/messages';
import { usePlatform } from '@/stores/platform';
import { api } from '@/lib/api';
import { pressComponent } from '@/lib/interactions';
import { cx, displayName, fileUrl } from '@/lib/format';
import { can } from '@/lib/perms';
import { myChannelPerms } from '@/lib/session';
import { pollEndsText, pollHint, pollOpen, pollPercent, sameSelection, toggleAnswer } from '@/lib/polls';
import { Avatar } from '@/components/ui/Avatar';
import { t } from '@/i18n';

/* ---------------------------------------------------------------- headers / notices */

/** "X used /name" above the reply of a slash command (Discord's interaction metadata line, drawn like a reply with the same connector). */
export function InteractionHeader({ m }: { m: Message }) {
  const i = m.interaction; const user = useData((s) => (i ? s.users[i.userId] : undefined)); const open = useUI((s) => s.openPopout);
  if (!i) return null;
  return (
    <div data-testid="interaction-header" className="relative mb-0.5 ms-[56px] flex items-center gap-1.5 pe-4 text-sm text-muted before:absolute before:-start-[36px] before:top-1/2 before:h-2.5 before:w-[30px] before:rounded-ss-md before:border-s-2 before:border-t-2 before:border-[rgb(var(--active))] before:content-['']" style={{ marginTop: 4 }}>
      {user && <Avatar user={user} size={16} />}
      <button className="shrink-0 font-medium text-interactive hover:text-header hover:underline" onClick={(e) => open({ kind: 'user', userId: i.userId, guildId: m.guildId ?? undefined, rect: e.currentTarget.getBoundingClientRect() })}>{user ? displayName(user) : 'Someone'}</button>
      <span className="shrink-0">{t('used')}</span><span className="truncate rounded bg-[rgb(var(--active)/0.6)] px-1 font-medium text-header">/{i.name ?? 'command'}</span>
    </div>
  );
}

export function EphemeralNotice({ m }: { m: Message }) {
  return (
    <div data-testid="ephemeral-notice" className="mt-1 flex items-center gap-1 text-xs text-muted"><EyeOff size={12} aria-hidden />
      <span>{t('Only you can see this')}</span><span aria-hidden>•</span>
      <button className="text-link hover:underline" onClick={() => useMessages.getState().remove(m.channelId, m.id)}>{t('Dismiss message')}</button>
    </div>
  );
}

export const isLoadingMsg = (m: Pick<Message, 'flags'>) => ((m.flags ?? 0) & MessageFlags.LOADING) !== 0;

export function ThinkingBody({ m }: { m: Message }) {
  return (
    <div data-testid="thinking" className="flex items-center gap-2 text-[16px] italic text-muted" role="status">
      <span>{m.author.displayName || m.author.username} {t('is thinking…')}</span>
      <span className="flex gap-0.5" aria-hidden>{[0, 1, 2].map((i) => <span key={i} className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted" style={{ animationDelay: `${i * 160}ms` }} />)}</span>
    </div>
  );
}

/* ---------------------------------------------------------------- components */

const BTN: Record<number, string> = {
  [ButtonStyle.PRIMARY]: 'bg-brand text-white hover:bg-brand-hover',
  [ButtonStyle.SECONDARY]: 'bg-[rgb(var(--active))] text-normal hover:bg-[rgb(var(--divider))]',
  [ButtonStyle.SUCCESS]: 'bg-success text-white hover:brightness-90',
  [ButtonStyle.DANGER]: 'bg-danger text-white hover:bg-danger-hover',
  [ButtonStyle.LINK]: 'bg-[rgb(var(--active))] text-normal hover:bg-[rgb(var(--divider))]',
};

function ButtonView({ m, c }: { m: Message; c: Component }) {
  const busy = usePlatform((s) => !!(c.customId && s.busy[`${m.id}:${c.customId}`]));
  const style = c.style ?? ButtonStyle.PRIMARY; const link = style === ButtonStyle.LINK;
  const cls = cx('inline-flex min-h-[32px] items-center justify-center gap-1.5 rounded-[3px] px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50', BTN[style] ?? BTN[ButtonStyle.PRIMARY]);
  const body = <>{c.emoji && <span aria-hidden>{c.emoji}</span>}{c.label}{link && <ExternalLink size={14} aria-hidden />}{busy && <Loader2 size={14} className="animate-spin" aria-hidden />}</>;
  if (link) return <a href={c.url} target="_blank" rel="noopener noreferrer nofollow" aria-disabled={c.disabled} className={cx(cls, c.disabled && 'pointer-events-none opacity-50')} data-component="button">{body}</a>;
  return <button type="button" disabled={c.disabled || busy} onClick={() => void pressComponent(m, c)} className={cls} data-component="button" data-custom-id={c.customId} aria-label={c.label || c.customId}>{body}</button>;
}

interface Opt { value: string; label: string; description?: string; emoji?: string; avatar?: Parameters<typeof Avatar>[0]['user']; default?: boolean }

/** Options for user/role/mentionable/channel selects come from the viewer's loaded guild data. */
export function useSelectOptions(m: Pick<Message, 'guildId' | 'channelId'>, c: Component): Opt[] {
  const g = useData((s) => (m.guildId ? s.guilds[m.guildId] : undefined));
  const dm = useData((s) => (!m.guildId ? s.dms[m.channelId] : undefined));
  return useMemo(() => {
    if (c.type === CT.STRING_SELECT) return (c.options ?? []).map((o: SelectOption) => ({ value: o.value, label: o.label, description: o.description, emoji: o.emoji, default: o.default }));
    const users = (): Opt[] => (g ? Object.values(g.members).map((x) => ({ value: x.user.id, label: displayName(x.user, x), description: x.user.username, avatar: x.user })) : (dm?.recipients ?? []).map((u) => ({ value: u.id, label: displayName(u), description: u.username, avatar: u })));
    const roles = (): Opt[] => Object.values(g?.roles ?? {}).filter((r) => r.id !== m.guildId).sort((a, b) => b.position - a.position).map((r) => ({ value: r.id, label: r.name }));
    const channels = (): Opt[] => Object.values(g?.channels ?? {}).filter((x) => x.type !== 'category' && x.type !== 'thread' && (!c.channelTypes?.length || c.channelTypes.includes(x.type))).sort((a, b) => a.position - b.position).map((x) => ({ value: x.id, label: `#${x.name}` }));
    if (c.type === CT.USER_SELECT) return users();
    if (c.type === CT.ROLE_SELECT) return roles();
    if (c.type === CT.MENTIONABLE_SELECT) return [...users(), ...roles()];
    if (c.type === CT.CHANNEL_SELECT) return channels();
    return [];
  }, [c, g, dm, m.guildId, m.channelId]);
}

function SelectView({ m, c }: { m: Message; c: Component }) {
  const opts = useSelectOptions(m, c);
  const min = c.minValues ?? 1; const max = Math.max(1, c.maxValues ?? 1); const multi = max > 1;
  const busy = usePlatform((s) => !!(c.customId && s.busy[`${m.id}:${c.customId}`]));
  const [open, setOpen] = useState(false); const [sel, setSel] = useState<string[]>(() => opts.filter((o) => o.default).map((o) => o.value));
  const ref = useRef<HTMLDivElement>(null); const dirty = useRef(false);
  const submit = (values: string[]) => { dirty.current = false; void pressComponent(m, c, values); };
  const close = () => { setOpen(false); if (multi && dirty.current && sel.length >= min) submit(sel); };
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (v: string) => {
    if (!multi) { setSel([v]); setOpen(false); submit([v]); return; }
    dirty.current = true;
    setSel((cur) => (cur.includes(v) ? cur.filter((x) => x !== v) : cur.length >= max ? cur : [...cur, v]));
  };
  const label = sel.length ? sel.map((v) => opts.find((o) => o.value === v)?.label ?? v).join(', ') : c.placeholder || t('Make a selection');
  return (
    <div ref={ref} className="relative w-full max-w-[420px]" data-component="select">
      <button type="button" role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-label={c.placeholder || c.customId || 'Select'} disabled={c.disabled || busy} onClick={() => (open ? close() : setOpen(true))}
        className="flex min-h-[40px] w-full items-center justify-between gap-2 rounded-[3px] bg-input px-3 text-start text-sm text-normal disabled:opacity-50">
        <span className={cx('truncate', !sel.length && 'text-muted')}>{label}</span>{busy ? <Loader2 size={16} className="animate-spin" /> : <ChevronDown size={16} className="shrink-0 text-muted" />}
      </button>
      {open && (
        <ul role="listbox" aria-multiselectable={multi} className="absolute inset-x-0 top-full z-30 mt-1 max-h-64 overflow-y-auto rounded-md bg-float p-1 shadow-elev">
          {!opts.length && <li className="px-2 py-2 text-sm text-muted">{t('Nothing to choose from')}</li>}
          {opts.map((o) => (
            <li key={o.value} role="option" aria-selected={sel.includes(o.value)}>
              <button type="button" onClick={() => pick(o.value)} className={cx('flex w-full items-center gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-hover', sel.includes(o.value) && 'bg-hover')}>
                {o.avatar ? <Avatar user={o.avatar} size={20} /> : o.emoji ? <span aria-hidden>{o.emoji}</span> : null}
                <span className="min-w-0 flex-1"><span className="block truncate font-medium text-header">{o.label}</span>{o.description && <span className="block truncate text-xs text-muted">{o.description}</span>}</span>
                {sel.includes(o.value) && <Check size={16} className="text-brand" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Action rows of buttons or a single select. Ephemeral messages' components are only usable by their recipient (the server enforces it too). */
export function MessageComponents({ m }: { m: Message }) {
  const rows = (m.components ?? []).filter((r) => r.type === CT.ACTION_ROW && r.components?.length);
  if (!rows.length) return null;
  return (
    <div className="mt-1 flex flex-col gap-2" data-testid="components">
      {rows.map((r, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2" role="group">
          {r.components!.map((c, j) => (c.type === CT.BUTTON ? <ButtonView key={c.customId ?? c.url ?? j} m={m} c={c} /> : <SelectView key={c.customId ?? j} m={m} c={c} />))}
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- polls */

export function PollView({ m }: { m: Message }) {
  const poll = m.poll; const me = useData((s) => s.me); const openModal = useUI((s) => s.openModal);
  const mineSrv = useMemo(() => (poll?.answers ?? []).filter((a) => a.meVoted).map((a) => a.id), [poll]);
  const [sel, setSel] = useState<number[]>(mineSrv); const [busy, setBusy] = useState(false); const [now, setNow] = useState(Date.now());
  useEffect(() => setSel(mineSrv), [mineSrv.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(i); }, []);
  if (!poll) return null;
  const open = pollOpen(poll, now); const changed = !sameSelection(sel, mineSrv);
  const perms = myChannelPerms(m.channelId); const isOwn = m.author.id === me?.id;
  const canEnd = open && (isOwn || (!!m.guildId && can(perms, Perm.MANAGE_MESSAGES)));
  const wrap = async (fn: () => Promise<Message>) => { setBusy(true); try { useMessages.getState().replace(await fn()); } catch (e) { toastError(e); } setBusy(false); };
  return (
    <div data-testid="poll" className="mt-1 w-full max-w-[420px] rounded-lg border border-divider bg-side p-3">
      <div className="mb-0.5 flex items-start gap-2"><BarChart3 size={18} className="mt-0.5 shrink-0 text-muted" aria-hidden /><h3 className="min-w-0 break-words text-base font-semibold text-header">{poll.question}</h3></div>
      <p className="mb-2 ps-[26px] text-xs text-muted">{pollHint(poll)}</p>
      <ul className="flex flex-col gap-1.5" role={poll.allowMultiselect ? 'group' : 'radiogroup'} aria-label={poll.question}>
        {poll.answers.map((a) => {
          const pct = pollPercent(a.count, poll.totalVotes); const picked = sel.includes(a.id);
          return (
            <li key={a.id}>
              <button type="button" disabled={!open || busy} role={poll.allowMultiselect ? 'checkbox' : 'radio'} aria-checked={picked} data-answer={a.id} onClick={() => setSel((s) => toggleAnswer(s, a.id, poll.allowMultiselect))}
                className={cx('relative flex w-full items-center gap-2 overflow-hidden rounded-md border px-3 py-2 text-start', picked ? 'border-brand' : 'border-divider', open ? 'hover:bg-hover' : 'cursor-default')}>
                <span className="absolute inset-y-0 start-0 bg-brand/20" style={{ width: `${pct}%` }} aria-hidden />
                <span className={cx('relative flex h-5 w-5 shrink-0 items-center justify-center border-2', poll.allowMultiselect ? 'rounded' : 'rounded-full', picked ? 'border-brand bg-brand text-white' : 'border-muted')} aria-hidden>{picked && <Check size={12} strokeWidth={4} />}</span>
                {a.emoji && <span className="relative" aria-hidden>{a.emoji}</span>}
                <span className="relative min-w-0 flex-1 break-words text-sm font-medium text-header">{a.text}</span>
                <span className="relative shrink-0 text-xs text-muted" data-testid="answer-count">{a.count} · {pct}%</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <span>{poll.totalVotes} {poll.totalVotes === 1 ? t('vote') : t('votes')}</span><span aria-hidden>•</span><span data-testid="poll-status">{pollEndsText(poll, now)}</span>
        {poll.totalVotes > 0 && <><span aria-hidden>•</span><button className="text-link hover:underline" onClick={() => openModal({ kind: 'pollVoters', channelId: m.channelId, messageId: m.id })}>{t('View votes')}</button></>}
      </div>
      {open && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button className="btn btn-primary" disabled={busy || !changed || !sel.length} onClick={() => void wrap(() => api.messages.vote(m.channelId, m.id, sel))}>{t('Vote')}</button>
          {mineSrv.length > 0 && <button className="btn btn-secondary" disabled={busy} onClick={() => void wrap(() => api.messages.removeVote(m.channelId, m.id))}>{t('Remove vote')}</button>}
          {canEnd && <button className="btn btn-link ms-auto text-danger" disabled={busy} onClick={() => openModal({ kind: 'confirm', title: 'End Poll', body: 'End this poll now? Voting will close and the results become final.', confirmLabel: 'End poll', danger: true, onConfirm: () => api.messages.endPoll(m.channelId, m.id).then((u) => useMessages.getState().replace(u)).catch(toastError) })}>{t('End poll')}</button>}
        </div>
      )}
    </div>
  );
}

/** System line for a finished poll (`type: 'poll_result'`; content is "question - winner won with N votes"). */
export function PollResultBody({ m }: { m: Message }) {
  return (
    <div data-testid="poll-result" className="mt-1 flex max-w-[420px] items-start gap-2 rounded-lg border border-divider bg-side p-3">
      <BarChart3 size={18} className="mt-0.5 shrink-0 text-brand" aria-hidden />
      <div className="min-w-0"><div className="text-xs font-bold uppercase tracking-wide text-muted">{t('Poll results')}</div><div className="break-words text-sm text-header">{m.content}</div></div>
    </div>
  );
}

export { isEphemeral, fileUrl };
