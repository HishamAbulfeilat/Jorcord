/** Modals added by the platform pass: polls, app modals, events, stages, screening, thread settings. */
import { useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { BookOpen, CalendarDays, Lock, MapPin, Plus, Radio, Trash2, Users, Volume2, X } from 'lucide-react';
import { ComponentType as CT, Perm, ScheduledEventEntityType as ET, ScheduledEventStatus as ST, AUTO_ARCHIVE_DURATIONS } from '@jorcord/shared';
import type { Component, Modal as ModalSpec, ScheduledEvent } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useData, selfMember } from '@/stores/data';
import { useUI, toast, toastError } from '@/stores/ui';
import { usePlatform, useLoadEvents } from '@/stores/platform';
import { useMessages } from '@/stores/messages';
import { SLOWMODES } from '@/lib/channelSync';
import { Field, Modal, Spinner, Toggle, Row, Empty } from '@/components/ui/primitives';
import { Markdown } from '@/components/chat/Markdown';
import { Avatar } from '@/components/ui/Avatar';
import { submitModal } from '@/lib/interactions';
import { POLL_DURATIONS, POLL_LIMITS, buildPoll } from '@/lib/polls';
import { entityLabel, isLive, isoToLocalInput, sortEvents, validateEvent, whenText } from '@/lib/events';
import { can, effectivePerms } from '@/lib/perms';
import { cx, displayName, fmtStamp, msgTime } from '@/lib/format';
import { myChannelPerms } from '@/lib/session';
import { useGuildPerms } from '@/lib/useGuild';
import { t } from '@/i18n';

/* ---------------------------------------------------------------- polls */

export function CreatePollModal({ channelId, close }: { channelId: string; close: () => void }) {
  const [question, setQuestion] = useState(''); const [answers, setAnswers] = useState(['', '']); const [hours, setHours] = useState(24); const [multi, setMulti] = useState(false);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = buildPoll({ question, answers, hours, multi }); if (!r.ok) { setErr(r.error); return; }
    setBusy(true); setErr('');
    try { const m = await api.messages.send(channelId, { content: '', poll: r.poll }); useMessages.getState().upsert(m); useData.getState().apply('MESSAGE_CREATE', m); close(); }
    catch (x) { toastError(x); setBusy(false); }
  };
  const set = (i: number, v: string) => setAnswers((a) => a.map((x, j) => (j === i ? v : x)));
  return (
    <Modal title={t('Create Poll')} onClose={close} footer={<><button className="btn btn-link" onClick={close}>{t('Cancel')}</button><button form="poll-form" type="submit" disabled={busy} className="btn btn-primary btn-lg sm:ms-auto">{t('Post')}</button></>}>
      <form id="poll-form" onSubmit={submit} aria-label={t('Create Poll')}>
        <Field label={t('Question')}><input className="field" value={question} maxLength={POLL_LIMITS.question} onChange={(e) => setQuestion(e.target.value)} placeholder={t('What question do you want to ask?')} autoFocus /></Field>
        <span className="label">{t('Answers')}</span>
        <ul className="mb-2 flex flex-col gap-2">{answers.map((a, i) => (
          <li key={i} className="flex items-center gap-2"><input className="field" aria-label={`Answer ${i + 1}`} value={a} maxLength={POLL_LIMITS.answer} onChange={(e) => set(i, e.target.value)} placeholder={`Answer ${i + 1}`} />
            {answers.length > 2 && <button type="button" aria-label={`Remove answer ${i + 1}`} onClick={() => setAnswers((x) => x.filter((_, j) => j !== i))} className="p-2 text-interactive hover:text-danger"><Trash2 size={16} /></button>}</li>))}</ul>
        {answers.length < POLL_LIMITS.answers && <button type="button" className="btn btn-secondary mb-4" onClick={() => setAnswers((a) => [...a, ''])}><Plus size={14} />{t('Add another answer')}</button>}
        <Field label={t('Duration')}><select className="field" value={hours} onChange={(e) => setHours(Number(e.target.value))}>{POLL_DURATIONS.map((d) => <option key={d.hours} value={d.hours}>{d.label}</option>)}</select></Field>
        <Row title={t('Allow multiple answers')}><Toggle label={t('Allow multiple answers')} checked={multi} onChange={setMulti} /></Row>
        {err && <p role="alert" className="mt-3 text-sm text-danger">{err}</p>}
      </form>
    </Modal>
  );
}

const PER_PAGE = 25;

export function PollVotersModal({ channelId, messageId, answerId, close }: { channelId: string; messageId: string; answerId?: number; close: () => void }) {
  const poll = useMessages((s) => s.ch[channelId]?.list.find((m) => m.id === messageId)?.poll);
  const [sel, setSel] = useState(answerId ?? poll?.answers[0]?.id ?? 1);
  const q = useInfiniteQuery({
    queryKey: ['poll-voters', channelId, messageId, sel],
    queryFn: ({ pageParam }) => api.messages.voters(channelId, messageId, sel, pageParam as string | undefined, PER_PAGE),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.length === PER_PAGE ? last[last.length - 1]!.id : undefined),
    staleTime: 5_000,
  });
  const users = q.data?.pages.flat() ?? [];
  return (
    <Modal title={t('Votes')} width={420} onClose={close}>
      <div role="tablist" aria-label={t('Answers')} className="mb-3 flex flex-wrap gap-1">{poll?.answers.map((a) => <button key={a.id} role="tab" aria-selected={sel === a.id} onClick={() => setSel(a.id)} className={cx('rounded px-2.5 py-1 text-sm font-medium', sel === a.id ? 'bg-active text-header' : 'text-interactive hover:bg-hover')}>{a.emoji} {a.text} · {a.count}</button>)}</div>
      {q.isLoading ? <Spinner className="mx-auto" /> : !users.length ? <p className="py-4 text-center text-sm text-muted">{t('No votes yet.')}</p>
        : <ul data-testid="voters">{users.map((u) => <li key={u.id} className="flex items-center gap-3 py-1.5"><Avatar user={u} size={28} /><span className="font-medium text-header">{displayName(u)}</span></li>)}</ul>}
      {q.hasNextPage && <button data-testid="voters-more" className="btn btn-secondary mb-1 block w-full" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>{t('Load more')}</button>}
    </Modal>
  );
}

/* ---------------------------------------------------------------- app modals */

export function InteractionModal({ spec, channelId, interactionId, close }: { spec: ModalSpec; channelId: string; interactionId: string; close: () => void }) {
  const inputs = useMemo(() => spec.components.flatMap((r) => (r.components ?? [r]).filter((c: Component) => c.type === CT.TEXT_INPUT && c.customId)), [spec]);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(inputs.map((c) => [c.customId!, c.value ?? ''])));
  const [busy, setBusy] = useState(false); const [tried, setTried] = useState(false);
  const errs = (c: Component) => { const v = values[c.customId!] ?? ''; if (c.required !== false && !v.trim()) return 'This field is required'; if (v && c.minLength && v.length < c.minLength) return `At least ${c.minLength} characters`; if (v && c.maxLength && v.length > c.maxLength) return `At most ${c.maxLength} characters`; return ''; };
  const bad = inputs.some((c) => errs(c));
  return (
    <Modal title={spec.title} onClose={close} footer={<><button className="btn btn-link" onClick={close}>{t('Cancel')}</button><button form="app-modal" type="submit" disabled={busy} className="btn btn-primary btn-lg sm:ms-auto">{t('Submit')}</button></>}>
      <form noValidate id="app-modal" aria-label={spec.title} onSubmit={async (e) => { e.preventDefault(); setTried(true); if (bad) return; setBusy(true); const ok = await submitModal(channelId, interactionId, spec, values); if (ok) close(); else setBusy(false); }}>
        {inputs.map((c, i) => {
          const e = tried ? errs(c) : '';
          return (
            <label key={c.customId} className="mb-4 block"><span className="label">{c.label}{c.required !== false && <span className="text-danger"> *</span>}</span>
              {c.textStyle === 2
                ? <textarea className={cx('field min-h-[100px]', e && 'ring-1 ring-danger')} aria-label={c.label || c.customId} value={values[c.customId!] ?? ''} maxLength={c.maxLength} placeholder={c.placeholder} onChange={(ev) => setValues((s) => ({ ...s, [c.customId!]: ev.target.value }))} autoFocus={i === 0} />
                : <input className={cx('field', e && 'ring-1 ring-danger')} aria-label={c.label || c.customId} value={values[c.customId!] ?? ''} maxLength={c.maxLength} placeholder={c.placeholder} onChange={(ev) => setValues((s) => ({ ...s, [c.customId!]: ev.target.value }))} autoFocus={i === 0} />}
              {e && <span role="alert" className="mt-1 block text-xs text-danger">{e}</span>}
            </label>
          );
        })}
      </form>
    </Modal>
  );
}

/* ---------------------------------------------------------------- scheduled events */

function useEventPerms(guildId: string) {
  const perms = useGuildPerms(guildId); const meId = useData((s) => s.me?.id);
  return { create: can(perms, Perm.CREATE_EVENTS), manage: can(perms, Perm.MANAGE_EVENTS), meId, perms };
}

function EventCard({ e }: { e: ScheduledEvent }) {
  const g = useData((s) => s.guilds[e.guildId]); const { create, manage, meId } = useEventPerms(e.guildId); const openModal = useUI((s) => s.openModal);
  const ch = e.channelId ? g?.channels[e.channelId] : undefined; const mine = e.creatorId === meId; const canEdit = manage || (mine && create);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); } catch (x) { toastError(x); } setBusy(false); };
  const toggle = () => run(async () => { const on = !e.interested; await api.guilds.eventInterest(e.guildId, e.id, on); usePlatform.getState().eventInterest(e.guildId, e.id, on ? 1 : -1, true); });
  const creator = useData((s) => s.users[e.creatorId]);
  return (
    <li data-event={e.id} className="rounded-lg border border-divider bg-modal-alt p-3">
      <div className="mb-1 flex items-center gap-2 text-xs font-bold uppercase tracking-wide">
        {isLive(e) ? <span className="rounded bg-success px-1.5 py-0.5 text-white" data-testid="event-live">{t('Live')}</span> : <CalendarDays size={14} className="text-muted" aria-hidden />}
        <span className={isLive(e) ? 'text-success' : 'text-brand'}>{isLive(e) ? t('Happening now') : whenText(e.scheduledStartTime)}</span>
      </div>
      <h3 className="break-words text-base font-bold text-header">{e.name}</h3>
      <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted">{e.entityType === ET.EXTERNAL ? <><MapPin size={14} aria-hidden />{e.location}</> : e.entityType === ET.STAGE_INSTANCE ? <><Radio size={14} aria-hidden />{ch?.name ?? entityLabel(e.entityType)}</> : <><Volume2 size={14} aria-hidden />{ch?.name ?? entityLabel(e.entityType)}</>}</p>
      {e.description && <p className="mt-1 whitespace-pre-wrap break-words text-sm text-normal">{e.description}</p>}
      {e.nextOccurrences && e.nextOccurrences.length > 0 && (
        <p className="mt-1 text-xs text-muted" data-testid="event-occurrences"><span className="font-medium">{t('Upcoming:')}</span>{' '}{e.nextOccurrences.map((iso, i) => <span key={iso}>{i > 0 && ', '}{whenText(iso)}</span>)}</p>
      )}
      <p className="mt-1 text-xs text-muted">{creator ? `${t('Created by')} ${displayName(creator)}` : ''}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button className={cx('btn', e.interested ? 'btn-secondary' : 'btn-primary')} aria-pressed={!!e.interested} disabled={busy} onClick={toggle}>{e.interested ? t('Interested ✓') : t('Interested')}</button>
        <span className="flex items-center gap-1 text-xs text-muted" data-testid="event-interested"><Users size={13} aria-hidden />{e.userCount} {t('interested')}</span>
        {canEdit && <span className="ms-auto flex gap-1">
          {e.status === ST.SCHEDULED && <button className="btn btn-secondary" disabled={busy} onClick={() => run(() => api.guilds.patchEvent(e.guildId, e.id, { status: ST.ACTIVE }))}>{t('Start Event')}</button>}
          {e.status === ST.ACTIVE && <button className="btn btn-secondary" disabled={busy} onClick={() => run(() => api.guilds.patchEvent(e.guildId, e.id, { status: ST.COMPLETED }))}>{t('End Event')}</button>}
          <button className="btn btn-secondary" onClick={() => openModal({ kind: 'eventEditor', guildId: e.guildId, eventId: e.id })}>{t('Edit')}</button>
          <button aria-label={`Cancel ${e.name}`} className="p-2 text-danger" disabled={busy} onClick={() => openModal({ kind: 'confirm', title: 'Cancel Event', body: `Cancel “${e.name}”? Interested members will no longer see it.`, confirmLabel: 'Cancel event', danger: true, onConfirm: () => api.guilds.patchEvent(e.guildId, e.id, { status: ST.CANCELED }).then(() => { usePlatform.getState().removeEvent(e); }).catch(toastError) })}><Trash2 size={16} /></button>
        </span>}
      </div>
    </li>
  );
}

export function EventsModal({ guildId, close }: { guildId: string; close: () => void }) {
  useLoadEvents(guildId);
  const evMap = usePlatform((s) => s.events[guildId]); const loaded = usePlatform((s) => !!s.eventsLoaded[guildId]);
  const list = useMemo(() => sortEvents(Object.values(evMap ?? {})), [evMap]); const { create } = useEventPerms(guildId); const openModal = useUI((s) => s.openModal);
  return (
    <Modal title={t('Events')} width={560} onClose={close} footer={create ? <button className="btn btn-primary btn-lg sm:ms-auto" onClick={() => openModal({ kind: 'eventEditor', guildId })}><Plus size={16} />{t('Create Event')}</button> : undefined}>
      {!loaded && !list.length ? <Spinner className="mx-auto" /> : !list.length ? <Empty icon={<CalendarDays size={44} />} title={t('There are no upcoming events')}>{create ? t('Schedule something for your community.') : t('Check back soon.')}</Empty>
        : <ul className="flex flex-col gap-3" aria-label={t('Upcoming events')}>{list.map((e) => <EventCard key={e.id} e={e} />)}</ul>}
    </Modal>
  );
}

export function EventEditorModal({ guildId, eventId, channelId, close }: { guildId: string; eventId?: string; channelId?: string; close: () => void }) {
  const g = useData((s) => s.guilds[guildId]); const existing = usePlatform((s) => (eventId ? s.events[guildId]?.[eventId] : undefined));
  const stage = Object.values(g?.channels ?? {}).filter((c) => c.type === 'stage').sort((a, b) => a.position - b.position);
  const voice = Object.values(g?.channels ?? {}).filter((c) => c.type === 'voice').sort((a, b) => a.position - b.position);
  const initialType = existing?.entityType ?? (channelId && g?.channels[channelId]?.type === 'stage' ? ET.STAGE_INSTANCE : ET.VOICE);
  const tomorrow = isoToLocalInput(new Date(Date.now() + 86_400_000).toISOString());
  const [d, setD] = useState({
    name: existing?.name ?? '', description: existing?.description ?? '', entityType: initialType, channelId: existing?.channelId ?? channelId ?? (initialType === ET.STAGE_INSTANCE ? stage[0]?.id : voice[0]?.id) ?? '',
    location: existing?.location ?? '', start: existing ? isoToLocalInput(existing.scheduledStartTime) : tomorrow, end: existing ? isoToLocalInput(existing.scheduledEndTime) : '',
    recurrenceRule: existing?.recurrenceRule ? { frequency: existing.recurrenceRule.frequency, interval: existing.recurrenceRule.interval, until: existing.recurrenceRule.until ? isoToLocalInput(existing.recurrenceRule.until) : '' } : null,
  });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  /** Back to the events list (the editor is opened from it). */
  const back = () => useUI.getState().openModal({ kind: 'events', guildId });
  const chans = d.entityType === ET.STAGE_INSTANCE ? stage : voice;
  const setType = (entityType: number) => setD((s) => ({ ...s, entityType, channelId: entityType === ET.EXTERNAL ? '' : ((entityType === ET.STAGE_INSTANCE ? stage : voice)[0]?.id ?? '') }));
  const locked = existing?.status === ST.ACTIVE;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = validateEvent(d, existing && !(Date.parse(d.start) > Date.now()) ? 0 : Date.now()); // editing a started event may keep its past start
    if (!r.ok) { setErr(r.error); return; }
    setBusy(true); setErr('');
    try {
      const ev = existing
        ? await api.guilds.patchEvent(guildId, existing.id, locked ? { name: r.body.name, description: r.body.description, scheduledEndTime: r.body.scheduledEndTime, location: r.body.location } : r.body)
        : await api.guilds.createEvent(guildId, r.body);
      usePlatform.getState().upsertEvent(ev); toast(existing ? t('Event updated') : t('Event created'), 'success'); back();
    } catch (x) { toastError(x); setBusy(false); }
  };
  return (
    <Modal title={existing ? t('Edit Event') : t('Create Event')} width={540} onClose={close} footer={<><button className="btn btn-link" onClick={back}>{t('Cancel')}</button><button form="event-form" type="submit" disabled={busy} className="btn btn-primary btn-lg sm:ms-auto">{existing ? t('Save') : t('Create Event')}</button></>}>
      <form id="event-form" aria-label={existing ? t('Edit Event') : t('Create Event')} onSubmit={submit}>
        <fieldset className="mb-4" disabled={locked}><legend className="label">{t('Where is your event?')}</legend>
          <div role="radiogroup" className="grid gap-2">{([[ET.VOICE, 'Voice Channel', Volume2], [ET.STAGE_INSTANCE, 'Stage Channel', Radio], [ET.EXTERNAL, 'Somewhere Else', MapPin]] as const).map(([id, label, Icon]) => (
            <label key={id} className={cx('flex cursor-pointer items-center gap-3 rounded-md bg-modal-alt p-3 hover:bg-hover', d.entityType === id && 'bg-active')}><Icon size={22} className="text-muted" aria-hidden /><span className="flex-1 font-semibold text-header">{label}</span><input type="radio" name="et" checked={d.entityType === id} onChange={() => setType(id)} className="h-5 w-5 accent-brand" /></label>))}</div></fieldset>
        {d.entityType === ET.EXTERNAL
          ? <Field label={t('Location')}><input className="field" value={d.location} maxLength={100} onChange={(e) => setD({ ...d, location: e.target.value })} placeholder={t('Add a link or a place')} /></Field>
          : <Field label={t('Channel')}><select className="field" aria-label={t('Channel')} disabled={locked} value={d.channelId} onChange={(e) => setD({ ...d, channelId: e.target.value })}>{!chans.length && <option value="">{t('No channels of this type')}</option>}{chans.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>}
        <Field label={t('Event Topic')}><input className="field" value={d.name} maxLength={100} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder={t('What is your event?')} autoFocus /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('Start Date')}><input className="field" type="datetime-local" value={d.start} disabled={locked} onChange={(e) => setD({ ...d, start: e.target.value })} /></Field>
          <Field label={d.entityType === ET.EXTERNAL ? t('End Date') : t('End Date (optional)')}><input className="field" type="datetime-local" aria-label={t('End Date')} value={d.end} onChange={(e) => setD({ ...d, end: e.target.value })} /></Field>
        </div>
        <Field label={t('Repeat')}>
          <select className="field" aria-label={t('Repeat')} value={d.recurrenceRule?.frequency ?? 'none'} onChange={(e) => { const v = e.target.value; setD({ ...d, recurrenceRule: v === 'none' ? null : { frequency: v as 'daily' | 'weekly' | 'monthly', interval: d.recurrenceRule?.interval ?? 1, until: d.recurrenceRule?.until ?? '' } }); }}>
            <option value="none">{t('Does not repeat')}</option>
            <option value="daily">{t('Daily')}</option>
            <option value="weekly">{t('Weekly')}</option>
            <option value="monthly">{t('Monthly')}</option>
          </select>
        </Field>
        {d.recurrenceRule && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('Repeat every')}><input className="field" type="number" min={1} max={12} aria-label={t('Repeat every')} value={d.recurrenceRule.interval} onChange={(e) => setD({ ...d, recurrenceRule: { ...d.recurrenceRule!, interval: Number(e.target.value) } })} /></Field>
            <Field label={t('End repeat (optional)')}><input className="field" type="datetime-local" aria-label={t('End repeat')} value={d.recurrenceRule.until} onChange={(e) => setD({ ...d, recurrenceRule: { ...d.recurrenceRule!, until: e.target.value } })} /></Field>
          </div>
        )}
        <Field label={t('Description')}><textarea className="field min-h-[80px]" value={d.description} maxLength={1000} onChange={(e) => setD({ ...d, description: e.target.value })} placeholder={t('Tell people more about your event')} /></Field>
        {err && <p role="alert" className="text-sm text-danger">{err}</p>}
      </form>
    </Modal>
  );
}

/* ---------------------------------------------------------------- stage topic */

export function StageModal({ channelId, mode, close }: { channelId: string; mode: 'start' | 'edit'; close: () => void }) {
  const ch = useData((s) => Object.values(s.guilds).map((g) => g.channels[channelId]).find(Boolean)); const cur = usePlatform((s) => s.stages[channelId]);
  const [topic, setTopic] = useState(mode === 'edit' ? cur?.topic ?? '' : ''); const [busy, setBusy] = useState(false);
  return (
    <Modal title={mode === 'start' ? t('Start Stage') : t('Edit Stage Topic')} width={420} onClose={close} footer={<><button className="btn btn-link" onClick={close}>{t('Cancel')}</button><button form="stage-form" type="submit" disabled={!topic.trim() || busy} className="btn btn-primary btn-lg sm:ms-auto">{mode === 'start' ? t('Start Stage') : t('Save')}</button></>}>
      <form id="stage-form" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true);
        try { const s = mode === 'start' ? await api.stages.start(channelId, topic.trim()) : await api.stages.setTopic(channelId, topic.trim()); usePlatform.getState().setStage(s); close(); } catch (x) { toastError(x); setBusy(false); }
      }}>
        <p className="mb-3 text-center text-sm text-muted">{mode === 'start' ? t('Let people know what {name} is about.', { name: ch?.name ?? 'the stage' }) : t('Change what this stage is about.')}</p>
        <Field label={t('Stage Topic')}><input className="field" value={topic} maxLength={120} onChange={(e) => setTopic(e.target.value)} placeholder={t('What is your stage about?')} autoFocus /></Field>
      </form>
    </Modal>
  );
}

/* ---------------------------------------------------------------- membership screening */

export function ScreeningModal({ guildId, close }: { guildId: string; close: () => void }) {
  const g = useData((s) => s.guilds[guildId]);
  const info = useQuery({ queryKey: ['screening', guildId], queryFn: () => api.guilds.screening(guildId), retry: false });
  const rulesId = info.data?.rulesChannelId ?? g?.guild.rulesChannelId ?? null;
  const rules = useQuery({ queryKey: ['rules', rulesId], enabled: !!rulesId, queryFn: () => api.messages.list(rulesId!, { limit: 30 }), retry: false });
  const [agree, setAgree] = useState(false); const [busy, setBusy] = useState(false);
  const done = async () => {
    setBusy(true);
    try { const m = await api.guilds.acceptScreening(guildId); useData.getState().apply('MEMBER_UPDATE', m); toast(t('Welcome! You can chat now.'), 'success'); close(); } catch (e) { toastError(e); setBusy(false); }
  };
  if (!g) return null;
  return (
    <Modal title={t('Review the rules')} width={520} onClose={close} footer={<><button className="btn btn-link" onClick={close}>{t('Maybe later')}</button><label className="flex items-center gap-2 text-sm sm:ms-auto"><input type="checkbox" aria-label={t('I have read and agree to the rules')} className="h-5 w-5 accent-brand" checked={agree} onChange={(e) => setAgree(e.target.checked)} />{t('I have read and agree to the rules')}</label><button disabled={!agree || busy} className="btn btn-primary btn-lg" onClick={done}>{t('Complete')}</button></>}>
      <p className="mb-3 flex items-center gap-2 text-sm text-muted"><BookOpen size={16} aria-hidden />{t('Please read the rules of {name} before you start chatting.', { name: g.guild.name })}</p>
      {info.data?.description && <p className="mb-3 whitespace-pre-wrap text-sm text-normal">{info.data.description}</p>}
      {rules.isLoading && <Spinner className="mx-auto my-6" />}
      {rules.isError && <p className="py-4 text-center text-sm text-muted">{t('The rules could not be loaded. Ask a moderator.')}</p>}
      <ol className="space-y-3" data-testid="screening-rules">{[...(rules.data ?? [])].reverse().map((m) => <li key={m.id} className="rounded-lg bg-modal-alt p-3 text-sm"><Markdown content={m.content} guildId={guildId} /><time className="mt-1 block text-xs text-muted">{fmtStamp(msgTime(m.id, m.createdAt))}</time></li>)}</ol>
      {rules.data && !rules.data.length && <p className="py-4 text-center text-sm text-muted">{t('The rules channel is empty.')}</p>}
    </Modal>
  );
}

/* ---------------------------------------------------------------- thread settings */

const ARCHIVE_LABEL: Record<number, string> = { 60: '1 Hour', 1440: '24 Hours', 4320: '3 Days', 10080: '1 Week' };

export function ThreadSettingsModal({ channelId, close }: { channelId: string; close: () => void }) {
  const th = useData((s) => Object.values(s.guilds).map((g) => g.channels[channelId]).find(Boolean));
  const g = useData((s) => (th?.guildId ? s.guilds[th.guildId] : undefined)); const parent = th?.parentId ? g?.channels[th.parentId] : undefined;
  const perms = th ? myChannelPerms(th.id) : 0n; const me = useData((s) => s.me); const manage = can(perms, Perm.MANAGE_THREADS); const owner = th?.ownerId === me?.id;
  const [f, setF] = useState({ name: th?.name ?? '', auto: th?.autoArchiveDuration ?? parent?.defaultAutoArchiveDuration ?? 1440, locked: !!th?.locked, slow: th?.slowmode ?? 0, tags: th?.appliedTags ?? [] as string[] });
  const [busy, setBusy] = useState(false);
  if (!th || !g) return null;
  const tags = parent?.availableTags ?? [];
  const save = async () => {
    setBusy(true);
    try {
      const u = await api.channels.patch(th.id, { ...(f.name !== th.name ? { name: f.name.trim() } : {}), autoArchiveDuration: f.auto, ...(manage ? { locked: f.locked, ...(f.slow !== th.slowmode ? { slowmode: f.slow } : {}) } : {}), ...(parent?.type === 'forum' || parent?.type === 'media' ? { appliedTags: f.tags } : {}) });
      useData.getState().apply('THREAD_UPDATE', { ...th, ...u }); toast(t('Thread updated'), 'success'); close();
    } catch (e) { toastError(e); setBusy(false); }
  };
  const archive = async (archived: boolean) => { try { const u = await api.channels.patch(th.id, { archived }); useData.getState().apply('THREAD_UPDATE', { ...th, ...u, archived }); close(); } catch (e) { toastError(e); } };
  return (
    <Modal title={t('Thread Settings')} onClose={close} footer={<><button className="btn btn-link" onClick={close}>{t('Cancel')}</button><button className="btn btn-primary btn-lg sm:ms-auto" disabled={busy || !f.name.trim()} onClick={save}>{t('Save Changes')}</button></>}>
      <Field label={t('Thread Name')}><input className="field" value={f.name} maxLength={100} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label={t('Hide After Inactivity')} hint={t('The thread archives itself after this long without messages. Any new message keeps it open.')}><select className="field" value={f.auto} onChange={(e) => setF({ ...f, auto: Number(e.target.value) })}>{AUTO_ARCHIVE_DURATIONS.map((d) => <option key={d} value={d}>{ARCHIVE_LABEL[d]}</option>)}</select></Field>
      {manage && <Field label={t('Slowmode')} hint={t('Members can post once per interval in this thread, unless they can manage threads or bypass slowmode.')}><select className="field" aria-label={t('Thread slowmode')} value={f.slow} onChange={(e) => setF({ ...f, slow: Number(e.target.value) })}>{SLOWMODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>}
      {manage && <Row title={t('Lock Thread')} desc={t('Only people with Manage Threads can send messages or unarchive a locked thread.')}><Toggle label={t('Lock thread')} checked={f.locked} onChange={(v) => setF({ ...f, locked: v })} /></Row>}
      {(parent?.type === 'forum' || parent?.type === 'media') && tags.length > 0 && (
        <div className="mt-3"><span className="label">{t('Tags')}</span>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('Tags')}>{tags.map((tg) => {
            const on = f.tags.includes(tg.id); const blocked = tg.moderated && !manage;
            return <button key={tg.id} type="button" aria-pressed={on} disabled={blocked} title={blocked ? t('Only moderators can apply this tag') : undefined} onClick={() => setF({ ...f, tags: on ? f.tags.filter((x) => x !== tg.id) : [...f.tags, tg.id].slice(0, 5) })}
              className={cx('rounded-full border px-2.5 py-0.5 text-sm font-medium disabled:opacity-40', on ? 'border-brand bg-brand/20 text-header' : 'border-active text-interactive hover:bg-hover')}>{tg.emoji} {tg.name}{tg.moderated && <Lock size={11} className="ms-1 inline" aria-hidden />}</button>;
          })}</div></div>
      )}
      <div className="mt-5 flex flex-wrap gap-2 border-t border-divider pt-4">
        {th.archived ? <button className="btn btn-secondary" disabled={!!th.locked && !manage} onClick={() => archive(false)}>{t('Unarchive Thread')}</button> : (manage || owner) && <button className="btn btn-secondary" onClick={() => archive(true)}>{t('Archive Thread')}</button>}
        {(manage || owner) && <button className="btn btn-danger ms-auto" onClick={() => useUI.getState().openModal({ kind: 'confirm', title: 'Delete Thread', body: `Delete “${th.name}” and all of its messages?`, confirmLabel: 'Delete Thread', danger: true, onConfirm: () => api.channels.delete(th.id).catch(toastError) })}>{t('Delete Thread')}</button>}
      </div>
    </Modal>
  );
}

void X; void selfMember; void effectivePerms;
