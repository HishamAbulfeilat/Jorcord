/** Notifications > Quiet mode: how often the notification digest lands in the Inbox, and the mentions-only default for big servers. */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LARGE_SERVER_MEMBER_THRESHOLD, type DigestFrequency } from '@jorcord/shared';
import { api } from '@/lib/api';
import { toastError } from '@/stores/ui';
import { H3 } from './SettingsLayout';
import { Row, Toggle } from '@/components/ui/primitives';
import { t } from '@/i18n';

export function DigestSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['digest-prefs'], queryFn: () => api.digest.prefs(), retry: false });
  const save = (b: Parameters<typeof api.digest.setPrefs>[0]) => api.digest.setPrefs(b).then((r) => qc.setQueryData(['digest-prefs'], r)).catch(toastError);
  if (q.isError) return null; // an older server without quiet mode
  const p = q.data;
  return (<div data-testid="digest-settings">
    <H3>{t('Quiet mode')}</H3>
    <p className="mb-3 text-sm text-muted">{t('Turn on "Add to my digest" in the notification settings of any server or channel. Its mentions then stop pinging you and arrive as one summary in your Inbox instead. The summary lists counts per channel; it never copies message text.')}</p>
    <Row title={t('Digest frequency')} desc={t('How long held-back notifications wait before they are gathered into a digest.')}>
      <select aria-label={t('Digest frequency')} className="field !w-auto" disabled={!p} value={p?.frequency ?? 'daily'} onChange={(e) => void save({ frequency: e.target.value as DigestFrequency })}>
        <option value="hourly">{t('Hourly')}</option><option value="daily">{t('Daily')}</option>
      </select>
    </Row>
    <Row title={t('Mentions only in big servers')} desc={t('When you join a server with more than {n} members, only notify me for @mentions until I choose otherwise.', { n: p?.largeServerThreshold ?? LARGE_SERVER_MEMBER_THRESHOLD })}>
      <Toggle label={t('Mentions only in big servers')} checked={p?.largeServerMentionsOnly ?? true} disabled={!p} onChange={(v) => void save({ largeServerMentionsOnly: v })} />
    </Row>
  </div>);
}
