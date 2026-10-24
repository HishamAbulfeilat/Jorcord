import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ModNotice } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { toast, toastError, useUI } from '@/stores/ui';
import { Modal, Toggle } from '@/components/ui/primitives';
import { fmtFull } from '@/lib/format';
import { t } from '@/i18n';

/**
 * Kick / ban dialog. The reason is kept in the audit log and (unless the server turned notices off) shown to the member, together with an appeal
 * link for bans. Kicks also carry the "remember roles" toggle: when on, a rejoin within the server's window gets the roles back.
 */
export function RemoveMemberModal({ mode, guildId, userId, close }: { mode: 'kick' | 'ban'; guildId: string; userId: string; close: () => void }) {
  const user = useData((s) => s.guilds[guildId]?.members[userId]?.user ?? s.users[userId]);
  const settings = useQuery({ queryKey: ['mod-settings', guildId], queryFn: () => api.guilds.modSettings(guildId), retry: false, staleTime: 60_000 });
  const [reason, setReason] = useState(''); const [remember, setRemember] = useState<boolean | null>(null); const [notify, setNotify] = useState<boolean | null>(null); const [busy, setBusy] = useState(false);
  const s = settings.data;
  const canRemember = !!s && s.rememberRoles.enabled; // the server switched role memory off: nothing to toggle
  const rememberOn = remember ?? (canRemember && s!.rememberRoles.onKick);
  const noticesOn = s ? s.notices.enabled : true;
  const notifyOn = notify ?? noticesOn;
  const name = user?.username ?? userId;
  const submit = async () => {
    setBusy(true);
    try {
      if (mode === 'kick') await api.guilds.kick(guildId, userId, { reason: reason.trim() || undefined, ...(canRemember ? { rememberRoles: rememberOn } : {}), ...(noticesOn ? { notify: notifyOn } : {}) });
      else await api.guilds.ban(guildId, userId, { reason: reason.trim() || undefined, deleteMessageSeconds: 0, ...(noticesOn ? { notify: notifyOn } : {}) });
      toast(mode === 'kick' ? t('Member kicked') : t('Member banned'), 'success'); close();
    } catch (e) { toastError(e); setBusy(false); }
  };
  return (
    <Modal title={mode === 'kick' ? t('Kick Member') : t('Ban Member')} onClose={close} width={440}
      footer={<><button className="btn btn-link" onClick={close}>{t('Cancel')}</button><button className="btn btn-danger" disabled={busy || settings.isLoading} onClick={() => void submit()}>{mode === 'kick' ? t('Kick') : t('Ban')}</button></>}>
      <p className="mb-3 text-sm text-muted">{mode === 'kick' ? t('Kick {name} from the server? They can rejoin with an invite.', { name }) : t('Ban {name}? They cannot rejoin, but can appeal.', { name })}</p>
      <label className="block"><span className="label">{t('Reason (optional)')}</span>
        <textarea className="field" rows={2} maxLength={512} value={reason} onChange={(e) => setReason(e.target.value)} aria-label={t('Reason')} /></label>
      {!settings.isLoading && noticesOn && (
        <div className="mt-3 flex items-start justify-between gap-3" data-testid="notify-row">
          <div className="text-sm"><div className="text-header">{t('Tell them why')}</div>
            <div className="text-xs text-muted">{s?.notices.showModerator ? t('They see the reason and your name.') : t('They see the reason, not who did it.')}{mode === 'ban' && s?.notices.appealLink ? ` ${t('A link to appeal is included.')}` : ''}</div></div>
          <Toggle checked={notifyOn} onChange={setNotify} label={t('Tell them why')} />
        </div>)}
      {mode === 'kick' && canRemember && (
        <div className="mt-3 flex items-start justify-between gap-3" data-testid="remember-row">
          <div className="text-sm"><div className="text-header">{t('Remember their roles')}</div>
            <div className="text-xs text-muted">{t('If they rejoin within {days} days they get their roles back, as long as you could still grant them.', { days: s!.rememberRoles.days })}</div></div>
          <Toggle checked={rememberOn} onChange={setRemember} label={t('Remember their roles')} />
        </div>)}
    </Modal>
  );
}

/** What a member sees after a moderator kicked, banned or timed them out: the reason and, for a ban, the way to appeal. */
export function ModNoticeModal({ notice, close }: { notice: ModNotice; close: () => void }) {
  const title = notice.kind === 'ban' ? t('You were banned from {server}', { server: notice.guildName }) : notice.kind === 'kick' ? t('You were removed from {server}', { server: notice.guildName }) : t('You were timed out in {server}', { server: notice.guildName });
  const done = () => { void api.modNotices.markRead().catch(() => {}); close(); };
  return (
    <Modal title={title} onClose={done} width={420}
      footer={<>{notice.appeal && <button className="btn btn-secondary" onClick={() => { done(); useUI.getState().openSettings({ kind: 'user', tab: 'privacy' }); }}>{t('Appeal')}</button>}<button className="btn btn-primary" onClick={done}>{t('OK')}</button></>}>
      <div data-testid="mod-notice">
        <p className="text-sm text-muted">{notice.reason ? t('The moderators gave this reason:') : t('The moderators did not give a reason.')}</p>
        {notice.reason && <p className="mt-2 whitespace-pre-wrap break-words rounded bg-side p-3 text-sm text-header" data-testid="mod-notice-reason">{notice.reason}</p>}
        {notice.moderatorId && <p className="mt-2 text-xs text-muted">{t('Decided by a moderator of this server.')}</p>}
        {notice.until && <p className="mt-2 text-xs text-muted">{t('The timeout ends {when}.', { when: fmtFull(new Date(notice.until).getTime()) })}</p>}
        {notice.appeal && <p className="mt-2 text-xs text-muted">{t('You can appeal this ban once, from Settings > Privacy & Safety > Bans.')}</p>}
      </div>
    </Modal>
  );
}
