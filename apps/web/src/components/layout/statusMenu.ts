import { Circle, Moon, MinusCircle, EyeOff, Settings } from 'lucide-react';
import type { Presence } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { useUI, toastError, type MenuItem } from '@/stores/ui';

export const setMyPresence = (p: Presence) => {
  const me = useData.getState().me; if (!me) return;
  useData.getState().apply('PRESENCE_UPDATE', { userId: me.id, presence: p });
  api.users.setPresence(p).catch(toastError);
};
export const statusMenu = (): MenuItem[] => {
  const cur = useData.getState().me ? useData.getState().presences[useData.getState().me!.id] ?? 'online' : 'online';
  return [
    { label: 'Online', icon: Circle, checked: cur === 'online', onClick: () => setMyPresence('online') },
    { label: 'Idle', icon: Moon, checked: cur === 'idle', onClick: () => setMyPresence('idle') },
    { label: 'Do Not Disturb', icon: MinusCircle, checked: cur === 'dnd', onClick: () => setMyPresence('dnd') },
    { label: 'Invisible', icon: EyeOff, checked: cur === 'invisible', onClick: () => setMyPresence('invisible') },
    { separator: true },
    { label: 'Edit Profile', icon: Settings, onClick: () => useUI.getState().openSettings({ kind: 'user', tab: 'profile' }) },
  ];
};
