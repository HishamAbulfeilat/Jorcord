/** "Send later": pick a time for the message in the composer (with its staged files), or edit a pending scheduled message. */
import { useState } from 'react';
import { CalendarClock, Paperclip, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import type { Attachment, ScheduledMessage } from '@jorcord/shared';
import { Modal } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { fromLocalInput, presets, scheduleProblem, schedulePatch, toLocalInput } from '@/lib/scheduledMessages';
import { toast, toastError } from '@/stores/ui';
import { t } from '@/i18n';

export function ScheduleModal({ channelId, content, replyTo, files = [], edit, onDone, close }: { channelId: string; content: string; replyTo?: string | null; files?: File[]; edit?: ScheduledMessage; onDone?: () => void; close: () => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState(edit ? edit.content : content);
  const [kept, setKept] = useState<Attachment[]>(edit?.attachments ?? []);
  const [extra, setExtra] = useState<File[]>(files);
  const [value, setValue] = useState(() => toLocalInput(edit ? new Date(edit.sendAt) : presets()[0]!.at)); const [busy, setBusy] = useState(false);
  const at = fromLocalInput(value); const problem = scheduleProblem(at);
  const empty = !text.trim() && !kept.length && !extra.length;
  const submit = async () => {
    if (!at || problem || empty) return;
    setBusy(true);
    try {
      const uploaded = await Promise.all(extra.map((f) => api.files.upload(f)));
      const ids = [...kept.map((a) => a.id), ...uploaded.map((a) => a.id)];
      if (edit) {
        const patch = schedulePatch(edit, { content: text, sendAt: at.toISOString(), attachmentIds: ids });
        if (Object.keys(patch).length) await api.messages.editScheduled(edit.id, patch);
        toast(t('Scheduled message updated'), 'success');
      } else {
        await api.messages.schedule(channelId, { content: text, sendAt: at.toISOString(), replyTo: replyTo ?? null, attachments: ids });
        toast(t('Message scheduled for {when}', { when: at.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) }), 'success');
      }
      void qc.invalidateQueries({ queryKey: ['inbox', 'scheduled'] });
      onDone?.(); close();
    } catch (e) { toastError(e); setBusy(false); }
  };
  return (
    <Modal title={edit ? t('Edit scheduled message') : t('Schedule message')} width={440} onClose={close}
      footer={<><button className="btn btn-link" onClick={close}>{t('Cancel')}</button><button className="btn btn-primary btn-lg sm:ms-auto" disabled={busy || !!problem || empty} onClick={() => void submit()} data-testid="schedule-confirm"><CalendarClock size={16} />{edit ? t('Save') : t('Schedule')}</button></>}>
      {edit
        ? <textarea className="field mb-3 min-h-20" value={text} maxLength={8000} onChange={(e) => setText(e.target.value)} aria-label={t('Message')} data-testid="schedule-text" />
        : text && <blockquote className="mb-3 max-h-24 overflow-y-auto whitespace-pre-wrap break-words rounded border-s-4 border-divider bg-side p-2 text-sm text-normal" data-testid="schedule-preview">{text}</blockquote>}
      {(kept.length > 0 || extra.length > 0) && (
        <ul className="mb-3 flex flex-col gap-1" aria-label={t('Attachments')} data-testid="schedule-files">
          {kept.map((a) => <li key={a.id} className="flex items-center gap-2 text-sm text-normal"><Paperclip size={14} /><span className="min-w-0 flex-1 truncate">{a.filename}</span>{edit && <button type="button" aria-label={t('Remove attachment')} className="text-muted hover:text-danger" onClick={() => setKept(kept.filter((x) => x.id !== a.id))}><X size={14} /></button>}</li>)}
          {extra.map((f, i) => <li key={`${f.name}-${i}`} className="flex items-center gap-2 text-sm text-normal"><Paperclip size={14} /><span className="min-w-0 flex-1 truncate">{f.name}</span>{edit && <button type="button" aria-label={t('Remove attachment')} className="text-muted hover:text-danger" onClick={() => setExtra(extra.filter((_, j) => j !== i))}><X size={14} /></button>}</li>)}
        </ul>)}
      {edit && <label className="btn btn-secondary mb-3 inline-flex cursor-pointer items-center gap-1"><Paperclip size={14} />{t('Add file')}<input type="file" multiple hidden onChange={(e) => { setExtra([...extra, ...(e.target.files ?? [])].slice(0, 10 - kept.length)); e.target.value = ''; }} /></label>}
      <div className="mb-3 flex flex-wrap gap-2">{presets().map((p) => <button key={p.id} type="button" className="btn btn-secondary" onClick={() => setValue(toLocalInput(p.at))}>{t(p.label)}</button>)}</div>
      <label className="label" htmlFor="sched-at">{t('Send at')}</label>
      <input id="sched-at" type="datetime-local" className="field" value={value} onChange={(e) => setValue(e.target.value)} data-testid="schedule-at" />
      {problem && <p className="mt-1 text-xs text-danger" role="alert">{t(problem)}</p>}
      <p className="mt-3 text-xs text-muted">{t('It is posted as you, and only if you can still post in this channel at that time. You can cancel it from the Inbox.')}</p>
    </Modal>
  );
}
