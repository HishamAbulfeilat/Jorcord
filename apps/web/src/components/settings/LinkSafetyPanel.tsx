/** Privacy & Safety: automatic idle timeout and the list of link domains that skip the external-link confirmation. */
import { useState } from 'react';
import { X } from 'lucide-react';
import { H3 } from './SettingsLayout';
import { Row } from '@/components/ui/primitives';
import { toast, useUI } from '@/stores/ui';
import { trustDomain, untrustDomain } from '@/lib/links';
import { t } from '@/i18n';

export const IDLE_CHOICES = [0, 1, 5, 10, 15, 30, 60] as const;

export function LinkSafetyPanel() {
  const idle = useUI((s) => s.prefs.idleMinutes); const set = useUI((s) => s.setPref);
  const trusted = useUI((s) => s.prefs.trustedLinkDomains ?? []);
  const [v, setV] = useState('');
  const add = () => { const h = trustDomain(v.trim()); if (h) setV(''); else toast(t('Enter a domain like example.com'), 'error'); };
  return (<div data-testid="link-safety">
    <H3>{t('Status')}</H3>
    <Row title={t('Go idle automatically')} desc={t('After this long without using Jorcord or your computer, your status changes from Online to Idle and back when you return. Do Not Disturb and Invisible are never changed.')}>
      <select className="field max-w-[180px]" aria-label={t('Go idle automatically')} value={idle} onChange={(e) => set('idleMinutes', Number(e.target.value))}>
        {IDLE_CHOICES.map((m) => <option key={m} value={m}>{m === 0 ? t('Never') : t('{n} minutes', { n: m })}</option>)}
      </select>
    </Row>
    <H3>{t('External links')}</H3>
    <p className="mb-2 text-sm text-muted">{t('Links to other websites ask for confirmation first. Domains you trust open straight away.')}</p>
    <form className="mb-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); add(); }}>
      <input className="field flex-1" aria-label={t('Trusted domain')} placeholder="example.com" value={v} onChange={(e) => setV(e.target.value)} maxLength={100} />
      <button type="submit" className="btn btn-secondary" disabled={!v.trim()}>{t('Trust domain')}</button>
    </form>
    {trusted.length === 0 ? <p className="mb-4 text-sm text-muted">{t('No trusted domains yet.')}</p> : (
      <ul className="mb-4 flex flex-wrap gap-2" data-testid="trusted-domains">{trusted.map((d) => (
        <li key={d} className="flex items-center gap-1 rounded bg-active px-2 py-1 text-sm text-header">{d}<button aria-label={t('Remove {d}', { d })} className="text-interactive hover:text-header" onClick={() => untrustDomain(d)}><X size={14} /></button></li>
      ))}</ul>
    )}
  </div>);
}
