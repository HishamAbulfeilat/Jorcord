import { ChevronDown, ChevronRight, Lock, MailQuestion, Plus, Users, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Channel } from '@jorcord/shared';
import { useData, channelUnread } from '@/stores/data';
import { useUI } from '@/stores/ui';
import { useNav, useRouteIds } from '@/lib/nav';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/primitives';
import { cx, dmName, compareId, fileUrl } from '@/lib/format';
import { dmMenu } from '@/lib/menus';
import { useMenuTrigger } from '@/components/ui/ContextMenu';
import { api } from '@/lib/api';
import { useShallow } from 'zustand/react/shallow';
import { t } from '@/i18n';

function DmRow({ c, quiet }: { c: Channel; quiet?: boolean }) {
  const me = useData((s) => s.me); const nav = useNav(); const { channelId } = useRouteIds();
  const { unread, mentions } = useData(useShallow((s) => channelUnread(s, c)));
  const other = (c.recipients ?? []).find((r) => r.id !== me?.id) ?? c.recipients?.[0];
  const custom = useData((s) => (other ? s.users[other.id]?.customStatus?.text : null));
  const trig = useMenuTrigger(() => dmMenu(c));
  const active = channelId === c.id;
  return (
    <li className="group relative mx-2" {...trig}>
      <button aria-current={active ? 'page' : undefined} onClick={() => nav.go('@me', c.id)} className={cx('touch flex w-full items-center gap-3 rounded px-2 text-start md:min-h-[42px]', active ? 'bg-active text-header' : 'hover:bg-hover', unread && !active ? 'text-header' : 'text-muted hover:text-interactive-hover')}>
        {c.type === 'group_dm' ? <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand text-white">{c.icon ? <img src={fileUrl(c.icon) ?? c.icon} alt="" className="h-full w-full object-cover" /> : <Users size={16} />}</span> : <Avatar user={other} size={32} presence />}
        <span className="min-w-0 flex-1 leading-tight">
          <span className={cx('block truncate text-[16px]', unread ? 'font-semibold' : 'font-medium')}>{dmName(c, me?.id)}{c.encrypted && <Lock size={12} className="ms-1 inline align-baseline" aria-label={t('Secret chat')} />}</span>
          {(c.type === 'group_dm' || custom) && <span className="block truncate text-xs text-muted">{c.type === 'group_dm' ? `${(c.recipients?.length ?? 0) + 1} Members` : custom}</span>}
        </span>
        {!quiet && <Badge n={mentions} />}
      </button>
      <button aria-label={t('Close DM')} onClick={() => api.channels.delete(c.id)} className="absolute end-2 top-1/2 hidden -translate-y-1/2 text-interactive hover:text-header group-hover:block md:group-hover:block"><X size={16} /></button>
    </li>
  );
}

export function DmSidebar() {
  const dms = useData((s) => s.dms); const nav = useNav(); const { channelId } = useRouteIds();
  const req = useData((s) => Object.values(s.relationships).filter((r) => r.type === 'incoming').length);
  const open = useUI((s) => s.openModal); const setSwitcher = useUI((s) => s.setSwitcher);
  const requestIds = useData((s) => s.messageRequests); const [showReq, setShowReq] = useState(false);
  const sorted = useMemo(() => Object.values(dms).sort((a, b) => compareId(b.lastMessageId ?? b.id, a.lastMessageId ?? a.id)), [dms]);
  const list = useMemo(() => sorted.filter((c) => !requestIds[c.id]), [sorted, requestIds]);
  const requests = useMemo(() => sorted.filter((c) => requestIds[c.id]), [sorted, requestIds]);
  const reqOpen = showReq || requests.some((c) => c.id === channelId);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center px-2.5 shadow-[0_1px_0_rgb(0_0_0/0.2)] safe-top box-content">
        <button onClick={() => setSwitcher(true)} className="flex h-[28px] w-full items-center rounded bg-rail px-2 text-start text-[13px] text-muted">{t('Find or start a conversation')}</button>
      </div>
      <div className="scroller min-h-0 flex-1 pt-2">
        <button onClick={() => nav.go('@me')} aria-current={!channelId ? 'page' : undefined} className={cx('touch mx-2 mb-2 flex w-[calc(100%-16px)] items-center gap-3 rounded px-2 text-start font-medium md:min-h-[42px]', !channelId ? 'bg-active text-header' : 'text-muted hover:bg-hover hover:text-interactive-hover')}>
          <Users size={24} /> <span className="flex-1">{t('Friends')}</span> <Badge n={req} />
        </button>
        {requests.length > 0 && (
          <div className="mb-1">
            <button aria-expanded={reqOpen} onClick={() => setShowReq(!reqOpen)} className="touch mx-2 flex w-[calc(100%-16px)] items-center gap-3 rounded px-2 text-start font-medium text-muted hover:bg-hover hover:text-interactive-hover md:min-h-[42px]">
              <MailQuestion size={24} /> <span className="flex-1">{t('Message Requests')}</span> <Badge n={requests.length} /> {reqOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </button>
            {reqOpen && <ul aria-label={t('Message Requests')} data-testid="message-requests">{requests.map((c) => <DmRow key={c.id} c={c} quiet />)}</ul>}
          </div>
        )}
        <div className="flex items-center justify-between px-4 pb-1 pt-3 text-muted hover:text-interactive-hover">
          <span className="section-title">{t('Direct Messages')}</span>
          <button aria-label={t('Create DM')} onClick={() => open({ kind: 'newDm' })}><Plus size={16} /></button>
        </div>
        <ul>{list.map((c) => <DmRow key={c.id} c={c} />)}</ul>
        {!list.length && <p className="px-4 py-6 text-center text-sm text-muted">{t('No conversations yet. Find a friend and say hi.')}</p>}
      </div>
    </div>
  );
}
