import { api } from './api';
import { endSession } from './session';
import { useAuth } from '@/stores/auth';
import { useMessages } from '@/stores/messages';

export async function logout() {
  try { await api.auth.logout(); } catch { /* offline: still clear locally */ }
  endSession(true); useAuth.getState().clear(); useMessages.setState({ ch: {}, pending: [] });
}
