import { api } from './api';
import { endSession } from './session';
import { useAuth } from '@/stores/auth';
import { useMessages } from '@/stores/messages';
import { disablePush } from './push';
import { useNotif } from '@/stores/notif';
import { accountsHere, activeAccountId, forgetAccount, switchAccount } from './accounts';

export async function logout() {
  await disablePush({ keepSubscription: true }).catch(() => {}); // forget this device before the token dies
  try { await api.auth.logout(); } catch { /* offline: still clear locally */ }
  const me = activeAccountId(); if (me) forgetAccount(me);
  endSession(true); useAuth.getState().clear(); useMessages.setState({ ch: {}, pending: [] }); useNotif.getState().reset();
  const next = accountsHere()[0]; // Discord-style: signing out of one account continues with another saved one
  if (next) switchAccount(next.id, (a, r) => useAuth.getState().set(a, r));
}
