/** User Settings > Registered Games (desktop only): the games Jorcord recognises and the activity toggle. */
import { useEffect, useState } from 'react';
import { Gamepad2, Trash2 } from 'lucide-react';
import { desktop, type RunningGames } from '@/lib/native';
import { resetGameActivity } from '@/lib/gameActivity';
import { useUI, type RegisteredGame } from '@/stores/ui';
import { H1, H3 } from './SettingsLayout';
import { Row, Toggle, Spinner } from '@/components/ui/primitives';
import { t } from '@/i18n';

export function RegisteredGamesTab() {
  const games = useUI((s) => s.prefs.registeredGames);
  const activity = useUI((s) => s.prefs.gameActivity);
  const set = useUI((s) => s.setPref);
  const [running, setRunning] = useState<RunningGames | null>(null);
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState('');
  const [label, setLabel] = useState('');
  const available = desktop.available();

  const refresh = async (list: RegisteredGame[] = useUI.getState().prefs.registeredGames) => {
    if (!available) return;
    setBusy(true);
    try { setRunning(await desktop.listRunningGames(list)); }
    catch { setRunning({ games: [], processes: [] }); }
    finally { setBusy(false); }
  };
  useEffect(() => { void refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const add = () => {
    const exe = pick.trim(); if (!exe) return;
    if (games.some((g) => g.executables.includes(exe))) return;
    const next: RegisteredGame[] = [...games, { name: label.trim() || exe, executables: [exe] }];
    set('registeredGames', next); setPick(''); setLabel(''); void refresh(next);
  };
  const remove = (name: string) => { const next = games.filter((g) => g.name !== name); set('registeredGames', next); void refresh(next); };
  const covered = new Set(games.flatMap((g) => g.executables));
  const addable = (running?.processes ?? []).filter((p) => !covered.has(p));

  if (!available) return (<><H1>{t('Registered Games')}</H1><p className="text-sm text-muted">{t('Game detection is only available in the desktop app.')}</p></>);

  return (<>
    <H1>{t('Registered Games')}</H1>
    <p className="mb-4 text-sm text-muted">{t('Jorcord shows "Playing <game>" in your profile while a game from this list is running.')}</p>
    <Row title={t('Display current activity')} desc={t('Show the game you are playing as your activity.')}>
      <Toggle label={t('Display current activity')} checked={activity} onChange={(v) => { set('gameActivity', v); if (!v) void resetGameActivity(); }} />
    </Row>

    <H3>{t('Registered Games')}</H3>
    {!games.length && <p className="text-sm text-muted" data-testid="no-registered">{t('No games registered yet. Add a running program below.')}</p>}
    <ul aria-label={t('Registered Games')}>{games.map((g) => (
      <li key={g.name} className="flex items-center gap-3 border-b border-divider/50 py-3">
        <Gamepad2 size={22} className="text-muted" />
        <div className="min-w-0 flex-1"><div className="truncate text-header">{g.name}</div><div className="text-xs text-muted">{g.executables.join(', ')}</div></div>
        <button aria-label={t('Remove {name}', { name: g.name })} className="p-2 text-danger" onClick={() => remove(g.name)}><Trash2 size={16} /></button>
      </li>))}</ul>

    <H3>{t('Currently running')}</H3>
    {busy && <Spinner size={14} />}
    {running && !running.games.length && <p className="text-sm text-muted" data-testid="none-detected">{t('No known games are running right now.')}</p>}
    <ul aria-label={t('Currently running')}>{running?.games.map((g) => (
      <li key={g.name} className="flex items-center gap-3 border-b border-divider/50 py-3">
        <Gamepad2 size={22} className="text-success" />
        <div className="min-w-0 flex-1"><div className="truncate text-header">{g.name}</div><div className="text-xs text-muted">{g.executable}</div></div>
      </li>))}</ul>

    <H3>{t('Add a game')}</H3>
    <div className="flex flex-wrap items-end gap-2">
      <label className="min-w-[160px] flex-1 text-xs font-bold uppercase text-header">{t('Running program')}
        <select aria-label={t('Running program')} className="field mt-1" value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">{t('Select a running program')}</option>
          {addable.map((p) => <option key={p} value={p}>{p}</option>)}
        </select></label>
      <label className="min-w-[160px] flex-1 text-xs font-bold uppercase text-header">{t('Display name')}
        <input aria-label={t('Display name')} className="field mt-1" maxLength={64} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={pick || t('Optional')} /></label>
      <button className="btn btn-primary btn-lg" disabled={!pick} onClick={add}>{t('Add game')}</button>
      <button className="btn btn-secondary btn-lg" disabled={busy} onClick={() => void refresh()}>{t('Refresh')}</button>
    </div>
  </>);
}
