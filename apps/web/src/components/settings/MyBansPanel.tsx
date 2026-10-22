import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type MyBan } from '@/lib/api';
import { toast, toastError } from '@/stores/ui';
import { H3 } from './SettingsLayout';
import { t } from '@/i18n';

/** User Settings > Privacy & Safety: servers that banned me, and the one appeal I get per ban. Renders nothing when I am not banned anywhere. */
export function MyBansPanel() {
  const q = useQuery({ queryKey: ['my-bans'], queryFn: api.myBans.list, retry: false });
  if (!q.data?.length) return null;
  return (<>
    <H3>{t('Server bans')}</H3>
    <p className="mb-2 text-sm text-muted">{t('You can send each server one appeal per ban. Only that server\'s moderators can read it.')}</p>
    <ul data-testid="my-bans">{q.data.map((b) => <BanRow key={b.guild.id} b={b} />)}</ul>
  </>);
}

function BanRow({ b }: { b: MyBan }) {
  const qc = useQueryClient(); const [open, setOpen] = useState(false); const [msg, setMsg] = useState(''); const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try { await api.myBans.appeal(b.guild.id, msg.trim()); toast(t('Appeal sent'), 'success'); setOpen(false); setMsg(''); await qc.invalidateQueries({ queryKey: ['my-bans'] }); }
    catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const a = b.appeal;
  return (
    <li className="border-b border-divider/50 py-3">
      <div className="flex items-center gap-3"><div className="min-w-0 flex-1"><div className="truncate text-header">{b.guild.name}</div><div className="text-xs text-muted">{t('Reason')}: {b.reason || t('none given')}</div></div>
        {a ? <span className="text-xs font-semibold text-muted">{a.status === 'pending' ? t('Appeal pending') : a.status === 'approved' ? t('Appeal approved') : t('Appeal denied')}</span>
          : !open && <button className="btn btn-secondary" onClick={() => setOpen(true)}>{t('Appeal ban')}</button>}</div>
      {a?.decisionReason && <div className="mt-1 text-xs text-muted">{t('Moderator note')}: {a.decisionReason}</div>}
      {open && !a && <form className="mt-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <textarea className="field min-h-[90px]" maxLength={1000} aria-label={t('Appeal message')} placeholder={t('Explain why the ban should be lifted (10-1000 characters)')} value={msg} onChange={(e) => setMsg(e.target.value)} autoFocus />
        <div className="mt-2 flex gap-2"><button className="btn btn-primary" disabled={busy || msg.trim().length < 10}>{t('Send appeal')}</button><button type="button" className="btn btn-secondary" onClick={() => setOpen(false)}>{t('Cancel')}</button></div></form>}
    </li>);
}
