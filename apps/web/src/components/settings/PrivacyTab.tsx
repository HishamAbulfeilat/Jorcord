/** User Settings > Privacy & Safety. Everything here is enforced server-side (DMs, friend requests, message requests, activity). */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Privacy } from '@jorcord/shared';
import { DEFAULT_PRIVACY } from '@jorcord/shared';
import { api } from '@/lib/api';
import { useData } from '@/stores/data';
import { toastError } from '@/stores/ui';
import { H1, H3 } from './SettingsLayout';
import { Row, Toggle } from '@/components/ui/primitives';
import { ACTIVITY_TYPES } from '@/lib/activity';
import { toast } from '@/stores/ui';
import type { ActivityType } from '@jorcord/shared';
import { MyBansPanel } from './MyBansPanel';
import { t } from '@/i18n';

type Patch = { [K in keyof Privacy]?: Privacy[K] extends object ? Partial<Privacy[K]> : Privacy[K] };

export function PrivacyTab() {
  const me = useData((s) => s.me)!; const p = me.privacy ?? DEFAULT_PRIVACY; const [busy, setBusy] = useState(false);
  const save = async (patch: Patch) => {
    setBusy(true);
    try { const u = await api.users.patchMe({ privacy: patch }); useData.getState().setMe(u); } catch (e) { toastError(e); } finally { setBusy(false); }
  };
  const fr = p.friendRequests;
  return (<>
    <H1>{t('Privacy & Safety')}</H1>
    <H3>{t('Activity')}</H3>
    <Row title={t('Share my activity')} desc={t('Show what you are playing, listening to or streaming in member lists, your friends list and your profile.')}>
      <Toggle label={t('Share my activity')} checked={p.showActivity} disabled={busy} onChange={(v) => void save({ showActivity: v })} />
    </Row>
    <ActivityEditor />
    <H3>{t('Direct Messages')}</H3>
    <Row title={t('Allow direct messages from server members')} desc={t('People you only share a server with can start a conversation. Friends can always message you.')}>
      <Toggle label={t('Allow direct messages from server members')} checked={p.allowDmsFromServerMembers} disabled={busy} onChange={(v) => void save({ allowDmsFromServerMembers: v })} />
    </Row>
    <Row title={t('Message requests')} desc={t('Messages from people who are not your friends go to a separate Message Requests list until you accept them.')}>
      <Toggle label={t('Message requests')} checked={p.messageRequests} disabled={busy} onChange={(v) => void save({ messageRequests: v })} />
    </Row>
    <ServerDmOptIns />
    <H3>{t('Who can add you as a friend')}</H3>
    <Row title={t('Everyone')} desc={t('Anyone who finds your username can send you a request.')}>
      <Toggle label={t('Everyone')} checked={fr.everyone} disabled={busy} onChange={(v) => void save({ friendRequests: { everyone: v } })} />
    </Row>
    <Row title={t('Friends of friends')}>
      <Toggle label={t('Friends of friends')} checked={fr.friendsOfFriends} disabled={busy} onChange={(v) => void save({ friendRequests: { friendsOfFriends: v } })} />
    </Row>
    <Row title={t('Server members')}>
      <Toggle label={t('Server members')} checked={fr.serverMembers} disabled={busy} onChange={(v) => void save({ friendRequests: { serverMembers: v } })} />
    </Row>
    <p className="mt-2 text-sm text-muted">{t('Turn all three off to stop receiving friend requests. You can still accept requests you already received.')}</p>
      <H3>{t('Age-restricted content')}</H3>
    <Row title={t('Allow access to age-restricted channels')} desc={t('You confirmed that you are 18 or older. Switch off to be asked again.')}>
      <Toggle label={t('Allow access to age-restricted channels')} checked={!!me.ageConfirmed} disabled={busy}
        onChange={(v) => { setBusy(true); (v ? api.users.confirmAge() : api.users.unconfirmAge()).then(() => useData.setState((st) => ({ me: st.me ? { ...st.me, ageConfirmed: v } : st.me }))).catch(toastError).finally(() => setBusy(false)); }} />
    </Row>
    <MyBansPanel />
</>);
}

/** Servers that make members opt in before other members can DM them: one switch per such server. */
function ServerDmOptIns() {
  const all = useData((s) => s.guilds);
  const optin = Object.values(all).map((g) => g.guild).filter((g) => g.memberDms === 'optin');
  if (!optin.length) return null;
  return (<div data-testid="server-dm-optins">
    {optin.map((g) => <ServerDmRow key={g.id} guildId={g.id} name={g.name} />)}
  </div>);
}
function ServerDmRow({ guildId, name }: { guildId: string; name: string }) {
  const qc = useQueryClient(); const q = useQuery({ queryKey: ['member-dms', guildId], queryFn: () => api.guilds.memberDmState(guildId) });
  if (!q.data) return null;
  return (
    <Row title={t('Allow DMs from members of {name}', { name })} desc={q.data.reachable && !q.data.optIn ? t('You joined before this was required, so members can already message you.') : t('This server asks members to opt in. Off by default for new members.')}>
      <Toggle label={t('Allow DMs from members of {name}', { name })} checked={q.data.reachable} disabled={q.data.reachable && !q.data.optIn}
        onChange={(v) => void api.guilds.setMemberDmOptIn(guildId, v).then((n) => qc.setQueryData(['member-dms', guildId], n)).catch(toastError)} />
    </Row>
  );
}

/** Manual activity (there is no game detection on the web): shows up like any other rich presence. */
function ActivityEditor() {
  const mine = useData((s) => (s.me ? s.activities[s.me.id] : undefined));
  const [type, setType] = useState<ActivityType>('playing'); const [name, setName] = useState(''); const [details, setDetails] = useState('');
  const set = () => api.users.setActivities([{ type, name: name.trim(), details: details.trim() || null }]).then((r) => { if (useData.getState().me) useData.setState((st) => ({ activities: { ...st.activities, [st.me!.id]: r.activities } })); toast(t('Activity updated'), 'success'); }).catch(toastError);
  const clear = () => api.users.clearActivities().then(() => { useData.setState((st) => { const { [st.me!.id]: _, ...rest } = st.activities; return { activities: rest }; }); }).catch(toastError);
  return (
    <div className="mb-4 rounded-lg bg-side p-3" data-testid="activity-editor">
      <div className="mb-2 text-sm text-muted">{t('Set an activity by hand. Bots and apps can do the same through the API.')}</div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs font-bold uppercase text-header">{t('Type')}<select aria-label={t('Activity type')} className="field mt-1 !w-auto" value={type} onChange={(e) => setType(e.target.value as ActivityType)}>{ACTIVITY_TYPES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></label>
        <label className="min-w-[140px] flex-1 text-xs font-bold uppercase text-header">{t('Name')}<input aria-label={t('Activity name')} className="field mt-1" maxLength={128} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="min-w-[140px] flex-1 text-xs font-bold uppercase text-header">{t('Details')}<input aria-label={t('Activity details')} className="field mt-1" maxLength={128} value={details} onChange={(e) => setDetails(e.target.value)} /></label>
        <button className="btn btn-primary btn-lg" disabled={!name.trim()} onClick={set}>{t('Set activity')}</button>
        {mine?.length ? <button className="btn btn-secondary btn-lg" onClick={clear}>{t('Clear')}</button> : null}
      </div>
    </div>
  );
}
