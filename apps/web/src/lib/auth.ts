import { api } from './api';
import { endSession } from './session';
import { useAuth } from '@/stores/auth';
import { useMessages } from '@/stores/messages';
import { disablePush } from './push';
import { useNotif } from '@/stores/notif';

export async function logout() {
  await disablePush({ keepSubscription: true }).catch(() => {}); // forget this device before the token dies
  try { await api.auth.logout(); } catch { /* offline: still clear locally */ }
  endSession(true); useAuth.getState().clear(); useMessages.setState({ ch: {}, pending: [] }); useNotif.getState().reset();
}
