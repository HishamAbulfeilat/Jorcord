import { Circle, Moon, MinusCircle, EyeOff, Settings, Smile, UserPlus, Users, Video, X } from 'lucide-react';
import { useAuth } from '@/stores/auth';
import { accountsHere, beginAddAccount, switchAccount } from '@/lib/accounts';
import type { Presence } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { useUI, toastError, type MenuItem } from '@/stores/ui';
import { t } from '@/i18n';

export const setMyPresence = (p: Presence) => {
  const me = useData.getState().me; if (!me) return;
  useData.getState().apply('PRESENCE_UPDATE', { userId: me.id, presence: p });
  api.users.setPresence(p).catch(toastError);
};
export const clearCustomStatus = () => {
  const me = useData.getState().me; if (!me) return;
  api.users.patchMe({ customStatus: null }).then((u) => { useData.getState().apply('USER_UPDATE', { ...me, ...u, customStatus: null }); }).catch(toastError);
};
export const statusMenu = (): MenuItem[] => {
  const s = useData.getState(); const cur = s.me ? s.presences[s.me.id] ?? 'online' : 'online'; const cs = s.me?.customStatus;
  const ui = useUI.getState();
  return [
    { label: t('Online'), icon: Circle, checked: cur === 'online', onClick: () => setMyPresence('online') },
    { label: t('Idle'), icon: Moon, checked: cur === 'idle', onClick: () => setMyPresence('idle') },
    { label: t('Do Not Disturb'), icon: MinusCircle, checked: cur === 'dnd', onClick: () => setMyPresence('dnd') },
    { label: t('Invisible'), icon: EyeOff, checked: cur === 'invisible', onClick: () => setMyPresence('invisible') },
    { separator: true },
    { label: cs?.text || cs?.emoji ? t('Edit Custom Status') : t('Set Custom Status'), icon: Smile, onClick: () => ui.openModal({ kind: 'customStatus' }) },
    ...(cs?.text || cs?.emoji ? [{ label: t('Clear Custom Status'), icon: X, onClick: clearCustomStatus }] : []),
    { separator: true },
    { label: t('Streamer Mode'), icon: Video, checked: ui.prefs.streamerMode, onClick: () => ui.setPref('streamerMode', !ui.prefs.streamerMode) },
    { label: t('Edit Profile'), icon: Settings, onClick: () => ui.openSettings({ kind: 'user', tab: 'profile' }) },
    { label: t('Switch Accounts'), icon: Users, children: [...accountsHere().map((a) => ({ label: a.displayName || a.username, checked: a.id === s.me?.id, disabled: a.id === s.me?.id, onClick: () => { switchAccount(a.id, (x, r) => useAuth.getState().set(x, r)); } })), { separator: true }, { label: t('Add Account'), icon: UserPlus, onClick: () => beginAddAccount() }] },
  ];
};
