/** "Send later": pick a time for the message in the composer. */
import { useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { fromLocalInput, presets, scheduleProblem, toLocalInput } from '@/lib/scheduledMessages';
import { toast, toastError } from '@/stores/ui';
import { t } from '@/i18n';

export function ScheduleModal({ channelId, content, replyTo, onDone, close }: { channelId: string; content: string; replyTo?: string | null; onDone?: () => void; close: () => void }) {
  const qc = useQueryClient();
  const [value, setValue] = useState(() => toLocalInput(presets()[0]!.at)); const [busy, setBusy] = useState(false);
  const at = fromLocalInput(value); const problem = scheduleProblem(at);
  const submit = async () => {
    if (!at || problem) return;
    setBusy(true);
    try {
      await api.messages.schedule(channelId, { content, sendAt: at.toISOString(), replyTo: replyTo ?? null });
      void qc.invalidateQueries({ queryKey: ['inbox', 'scheduled'] });
      toast(t('Message scheduled for {when}', { when: at.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) }), 'success');
      onDone?.(); close();
    } catch (e) { toastError(e); setBusy(false); }
  };
  return (
    <Modal title={t('Schedule message')} width={440} onClose={close}
      footer={<><button className="btn btn-link" onClick={close}>{t('Cancel')}</button><button className="btn btn-primary btn-lg sm:ms-auto" disabled={busy || !!problem} onClick={() => void submit()} data-testid="schedule-confirm"><CalendarClock size={16} />{t('Schedule')}</button></>}>
      <blockquote className="mb-3 max-h-24 overflow-y-auto whitespace-pre-wrap break-words rounded border-s-4 border-divider bg-side p-2 text-sm text-normal" data-testid="schedule-preview">{content}</blockquote>
      <div className="mb-3 flex flex-wrap gap-2">{presets().map((p) => <button key={p.id} type="button" className="btn btn-secondary" onClick={() => setValue(toLocalInput(p.at))}>{t(p.label)}</button>)}</div>
      <label className="label" htmlFor="sched-at">{t('Send at')}</label>
      <input id="sched-at" type="datetime-local" className="field" value={value} onChange={(e) => setValue(e.target.value)} data-testid="schedule-at" />
      {problem && <p className="mt-1 text-xs text-danger" role="alert">{t(problem)}</p>}
      <p className="mt-3 text-xs text-muted">{t('It is posted as you, and only if you can still post in this channel at that time. You can cancel it from the Inbox.')}</p>
    </Modal>
  );
}
