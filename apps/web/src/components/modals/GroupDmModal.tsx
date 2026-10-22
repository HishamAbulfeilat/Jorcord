import { useState } from 'react';
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { toast, toastError } from '@/stores/ui';
import { Modal, Field } from '@/components/ui/primitives';
import { IconPicker } from './ModalHost';
import { Avatar } from '@/components/ui/Avatar';
import { displayName } from '@/lib/format';
import { t } from '@/i18n';

/** Group DM settings: name, icon and (owner only) ownership transfer. */
export function GroupDmModal({ channelId, close }: { channelId: string; close: () => void }) {
  const c = useData((s) => s.dms[channelId]); const me = useData((s) => s.me);
  const [name, setName] = useState(c?.name ?? ''); const [icon, setIcon] = useState<string | null>(c?.icon ?? null); const [busy, setBusy] = useState(false);
  if (!c || c.type !== 'group_dm') return null;
  const isOwner = c.ownerId === me?.id;
  const others = (c.recipients ?? []).filter((r) => r.id !== me?.id);
  const apply = (u: Partial<typeof c>) => useData.getState().apply('CHANNEL_UPDATE', { ...c, ...u });
  const save = async () => {
    setBusy(true);
    try { apply(await api.channels.patch(c.id, { name: name.trim() || null, icon })); toast(t('Group updated'), 'success'); close(); } catch (e) { toastError(e); }
    setBusy(false);
  };
  const transfer = async (userId: string) => {
    try { apply(await api.channels.patch(c.id, { ownerId: userId })); toast(t('Ownership transferred'), 'success'); } catch (e) { toastError(e); }
  };
  return (
    <Modal title={t('Group Settings')} onClose={close} footer={<div className="flex justify-end gap-2"><button className="btn btn-secondary" onClick={close}>{t('Cancel')}</button><button className="btn btn-primary" disabled={busy} onClick={save}>{t('Save')}</button></div>}>
      <div className="flex flex-col gap-4">
        <IconPicker value={icon} onChange={setIcon} label={t('Icon')} size={72} />
        <Field label={t('Group name')}><input className="field" aria-label={t('Group name')} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder={(c.recipients ?? []).map((r) => r.displayName || r.username).join(', ')} /></Field>
        {isOwner && others.length > 0 && <div>
          <span className="label">{t('Transfer ownership')}</span>
          <ul>{others.map((u) => <li key={u.id} className="flex items-center gap-3 py-1"><Avatar user={u} size={28} /><span className="flex-1 truncate">{displayName(u)}</span><button className="btn btn-secondary" aria-label={t('Make {name} owner', { name: displayName(u) })} onClick={() => transfer(u.id)}>{t('Make owner')}</button></li>)}</ul>
        </div>}
      </div>
    </Modal>
  );
}
