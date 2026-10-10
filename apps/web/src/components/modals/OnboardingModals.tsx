import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Id } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { toast, toastError } from '@/stores/ui';
import { Modal, Spinner } from '@/components/ui/primitives';
import { cx } from '@/lib/format';
import { t } from '@/i18n';

/** "Channels & Roles": answer the server's onboarding questions (also shown to newcomers right after they join). */
export function CustomizeModal({ guildId, close }: { guildId: Id; close: () => void }) {
  const g = useData((s) => s.guilds[guildId]); const qc = useQueryClient();
  const q = useQuery({ queryKey: ['onboarding', guildId], queryFn: () => api.guilds.onboarding(guildId), staleTime: 0 });
  const [picked, setPicked] = useState<Set<Id>>(new Set()); const [busy, setBusy] = useState(false); const [init, setInit] = useState(false);
  useEffect(() => { if (q.data && !init) { setPicked(new Set(q.data.responses?.optionIds ?? [])); setInit(true); } }, [q.data, init]);
  const channels = g?.channels ?? {};
  const toggle = (pid: Id, oid: Id, single: boolean) => setPicked((s) => {
    const n = new Set(s); const p = q.data!.prompts.find((x) => x.id === pid)!;
    if (n.has(oid)) n.delete(oid); else { if (single) p.options.forEach((o) => n.delete(o.id)); n.add(oid); }
    return n;
  });
  const missing = q.data?.prompts.filter((p) => p.required && !p.options.some((o) => picked.has(o.id))) ?? [];
  const submit = async () => {
    setBusy(true);
    try { const r = await api.guilds.answerOnboarding(guildId, [...picked]); qc.setQueryData(['onboarding', guildId], { ...q.data!, responses: r }); toast(t('Saved your choices'), 'success'); close(); }
    catch (e) { toastError(e); setBusy(false); }
  };
  return (
    <Modal title={t('Channels & Roles')} onClose={close} width={520}
      footer={<><button className="btn btn-link" onClick={close}>{t('Skip for now')}</button><button className="btn btn-primary btn-lg sm:ms-auto" disabled={busy || !q.data || missing.length > 0} onClick={submit}>{t('Save')}</button></>}>
      {q.isLoading && <Spinner className="mx-auto my-6" />}
      {q.data && !q.data.prompts.length && <p className="py-4 text-center text-sm text-muted">{t('This server has no questions.')}</p>}
      <div data-testid="onboarding-questions" className="space-y-5">
        {q.data?.prompts.map((p) => (
          <fieldset key={p.id}>
            <legend className="mb-2 font-bold text-header">{p.title}{p.required && <span className="ms-1 text-danger" aria-label={t('required')}>*</span>}</legend>
            <p className="mb-2 text-xs text-muted">{p.singleSelect ? t('Pick one') : t('Pick any that apply')}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {p.options.map((o) => {
                const on = picked.has(o.id);
                const names = o.channelIds.map((c) => channels[c]?.name).filter(Boolean);
                return (
                  <button key={o.id} type="button" role={p.singleSelect ? 'radio' : 'checkbox'} aria-checked={on} onClick={() => toggle(p.id, o.id, p.singleSelect)}
                    className={cx('rounded-lg border-2 p-3 text-start hover:bg-hover', on ? 'border-brand bg-brand/10' : 'border-transparent bg-side')}>
                    <span className="block font-semibold text-header">{o.emoji && <span className="me-1">{o.emoji}</span>}{o.title}</span>
                    {o.description && <span className="block text-xs text-muted">{o.description}</span>}
                    {names.length > 0 && <span className="mt-1 block truncate text-xs text-muted">{names.map((n) => `#${n}`).join(' ')}</span>}
                  </button>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>
    </Modal>
  );
}
