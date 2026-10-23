/** Secret chats (end-to-end encrypted 1:1 DMs): the message body, the status bar above the composer, and the safety-number dialog. See docs/E2EE_DMS.md. */
import { useEffect } from 'react';
import { AlertTriangle, Lock, ShieldCheck } from 'lucide-react';
import type { Message } from '@jorcord/shared';
import { Markdown } from './Markdown';
import { Modal } from '@/components/ui/primitives';
import { useData } from '@/stores/data';
import { useUI, toast, toastError } from '@/stores/ui';
import { useSecret, type Opened } from '@/stores/secret';
import { formatFingerprint } from '@/lib/e2ee/crypto';
import { t } from '@/i18n';

const WHY: Record<string, string> = {
  not_for_this_device: 'Sent before this device was set up for secret chats, so this device cannot open it.',
  unknown_sender_device: 'The sending device is not known, so this message cannot be verified.',
  authentication_failed: 'This message failed verification and was not shown.',
  malformed: 'This message is not valid encrypted data.',
  error: 'Encryption keys could not be loaded.',
};

/** Decrypts (once, in memory only) the message the server stored as ciphertext. */
export function useSecretText(m: Message): Opened | undefined {
  const channel = useData((s) => s.dms[m.channelId]);
  const meId = useData((s) => s.me?.id);
  const opened = useSecret((s) => s.opened[m.id]);
  useEffect(() => { if (!opened && channel?.encrypted && meId) void useSecret.getState().open(channel, meId, m); }, [opened, channel, meId, m]);
  return opened;
}

function SecretBody({ m }: { m: Message }) {
  const r = useSecretText(m);
  if (!r) return <span className="italic text-muted" data-testid="secret-pending">{t('Decrypting…')}</span>;
  if (!r.ok) return <span className="inline-flex items-center gap-1.5 italic text-muted" data-testid="secret-failed"><AlertTriangle size={14} aria-hidden /> {t(WHY[r.reason] ?? WHY.error!)}</span>;
  return <span data-testid="secret-text"><Markdown content={r.text} /></span>;
}

/** What a message shows as text: Markdown for normal messages, the decrypted text for messages in a secret chat. */
export function MessageText({ m, guildId }: { m: Message; guildId?: string | null }) {
  const secret = useData((s) => !!s.dms[m.channelId]?.encrypted);
  if (secret && (m.type === 'default' || m.type === 'reply')) return <SecretBody m={m} />;
  return <Markdown content={m.content} guildId={guildId ?? undefined} />;
}

/** Status line above the composer of a secret chat. */
export function SecretBar({ channelId }: { channelId: string }) {
  const channel = useData((s) => s.dms[channelId]);
  const meId = useData((s) => s.me?.id);
  const cc = useSecret((s) => s.cc[channelId]);
  const error = useSecret((s) => s.error[channelId]);
  const openModal = useUI((s) => s.openModal);
  useEffect(() => { if (channel?.encrypted && meId) void useSecret.getState().load(channel, meId); }, [channel, meId]);
  if (!channel?.encrypted) return null;
  const changed = cc?.trust.status === 'changed';
  const noPeer = !!cc && cc.theirs.length === 0;
  const tone = changed || error ? 'bg-danger/15 text-header' : 'bg-side text-muted';
  return (
    <div role={changed || error ? 'alert' : 'status'} data-testid="secret-bar" className={`mx-4 mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-3 py-1.5 text-xs ${tone}`}>
      {changed ? <AlertTriangle size={14} aria-hidden className="shrink-0 text-danger" /> : <Lock size={14} aria-hidden className="shrink-0" />}
      <span className="min-w-0 flex-1">
        {error ? t('Encryption keys could not be loaded: {why}', { why: error })
          : changed ? t("Their security keys changed. Messages stay blocked until you review the safety number.")
          : noPeer ? t('Secret chat. They have not set up secret chats on any device yet, so you cannot send until they do.')
          : t('Secret chat. End-to-end encrypted: the server only sees ciphertext. No link previews, search, attachments or edits.')}
        {cc && !cc.persistent && <> {t('This browser cannot store keys, so history will be unreadable after you close the tab.')}</>}
      </span>
      {cc && <button type="button" className="shrink-0 font-semibold text-link hover:underline" onClick={() => openModal({ kind: 'safetyNumber', channelId })}>{changed ? t('Review') : cc.verified ? t('Verified') : t('Verify safety number')}</button>}
    </div>
  );
}

export function SafetyNumberModal({ channelId, close }: { channelId: string; close: () => void }) {
  const channel = useData((s) => s.dms[channelId]);
  const meId = useData((s) => s.me?.id);
  const cc = useSecret((s) => s.cc[channelId]);
  useEffect(() => { if (channel && meId) void useSecret.getState().load(channel, meId, true); }, [channel, meId]);
  const peer = channel?.recipients?.find((r) => r.id !== meId);
  const peerName = peer?.displayName || peer?.username || t('them');
  const changed = cc?.trust.status === 'changed';
  const act = async (verified?: boolean) => {
    if (!channel || !meId) return;
    try { await useSecret.getState().accept(channel, meId, verified); toast(verified ? t('Marked as verified') : t('New keys accepted'), 'success'); if (verified || changed) close(); } catch (e) { toastError(e); }
  };
  return (
    <Modal title={t('Safety number')} onClose={close} width={500}>
      {!cc ? <p className="text-sm text-muted">{t('Loading keys…')}</p> : (<div data-testid="safety-modal">
        {changed && <p role="alert" className="mb-3 rounded bg-danger/15 p-2 text-sm text-header">{t("{name}'s security keys changed ({n} new or replaced). This happens when they set up a new device or reinstall, but it is also what an attack on the server would look like. Compare the new number with them in person or over a call you trust before accepting.", { name: peerName, n: cc.trust.added.length + cc.trust.changed.length })}</p>}
        <p className="mb-2 text-sm text-muted">{t('If this number is the same on your screen and on {name}\'s, nobody (including the server) is sitting between you. Compare it over a channel you trust.', { name: peerName })}</p>
        <pre data-testid="safety-number" aria-label={t('Safety number')} className="mb-3 whitespace-pre rounded bg-rail p-3 text-center font-mono text-lg tracking-wider text-header">{cc.safety}</pre>
        <details className="mb-3 text-xs text-muted">
          <summary className="cursor-pointer">{t('Device fingerprints')}</summary>
          <ul className="mt-1 space-y-1 font-mono">
            {[...cc.mine.map((d) => ({ d, who: t('You') })), ...cc.theirs.map((d) => ({ d, who: peerName }))].map(({ d, who }) => (
              <li key={d.id}><b className="font-sans">{who}</b> · {d.label ?? t('device')}{d.id === cc.me.deviceId ? ` (${t('this device')})` : ''}<br />{formatFingerprint(d.fp)}</li>
            ))}
          </ul>
        </details>
        <div className="flex flex-wrap justify-end gap-2">
          <button className="btn btn-secondary" onClick={close}>{t('Close')}</button>
          {changed && <button className="btn btn-danger" onClick={() => void act(false)}>{t('Accept new keys')}</button>}
          {!changed && !cc.verified && <button className="btn btn-primary" onClick={() => void act(true)}><ShieldCheck size={16} className="me-1 inline" aria-hidden />{t('Mark as verified')}</button>}
        </div>
      </div>)}
    </Modal>
  );
}
