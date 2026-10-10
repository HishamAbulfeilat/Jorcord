import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useAuth } from '@/stores/auth';
import { useData } from '@/stores/data';
import { Avatar } from '@/components/ui/Avatar';
import { H3 } from './SettingsLayout';
import { accountsHere, beginAddAccount, forgetAccount, switchAccount } from '@/lib/accounts';
import { apiBase } from '@/lib/server';
import { t } from '@/i18n';

/** My Account > Accounts: other accounts signed in on this device; switch with one click. */
export function AccountsSection() {
  const me = useData((s) => s.me); const [, bump] = useState(0);
  const list = accountsHere();
  const remove = async (id: string, access: string) => {
    try { await fetch(`${apiBase()}/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${access}` } }); } catch { /* offline: still forget it here */ }
    forgetAccount(id); bump((n) => n + 1);
  };
  return (<div data-testid="accounts-section">
    <H3>{t('Accounts')}</H3>
    <p className="mb-2 text-sm text-muted">{t('Sign in to more than one account on this device and switch between them without logging out.')}</p>
    <ul className="mb-3 space-y-2">{list.map((a) => (
      <li key={a.id} className="flex items-center gap-3 rounded-lg bg-side p-2" data-testid="account-row">
        <Avatar user={a} size={36} />
        <span className="min-w-0 flex-1 leading-tight"><span className="block truncate font-semibold text-header">{a.displayName || a.username}</span><span className="block truncate text-xs text-muted">{a.username}</span></span>
        {a.id === me?.id ? <span className="text-xs font-semibold text-success">{t('Current')}</span> : (<>
          <button className="btn btn-primary" aria-label={`${t('Switch to')} ${a.displayName || a.username}`} onClick={() => switchAccount(a.id, (x, r) => useAuth.getState().set(x, r))}>{t('Switch')}</button>
          <button className="btn btn-secondary" aria-label={`${t('Remove')} ${a.displayName || a.username}`} onClick={() => void remove(a.id, a.access)}>{t('Remove')}</button></>)}
      </li>
    ))}</ul>
    <button className="btn btn-secondary" onClick={() => beginAddAccount()}><Plus size={14} />{t('Add Account')}</button>
  </div>);
}
