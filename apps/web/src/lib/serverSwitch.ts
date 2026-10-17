import { getServerUrl, setServerUrl } from './server';
import { useAuth } from '@/stores/auth';
import { useData } from '@/stores/data';
import { useMessages } from '@/stores/messages';
import { useNotif } from '@/stores/notif';
import { endSession } from './session';
import { queryClient } from './queryClient';

/** Point the app at another server: drops the session (tokens belong to one server) and every cached response. */
export function switchServer(origin: string | null) {
  if ((origin ?? '') === getServerUrl()) return false;
  endSession(true);
  useAuth.getState().clear();
  useMessages.setState({ ch: {}, pending: [] });
  useNotif.getState().reset();
  queryClient.clear();
  setServerUrl(origin);
  return true;
}
