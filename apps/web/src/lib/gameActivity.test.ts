import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/native', () => ({ desktop: { available: vi.fn(), listRunningGames: vi.fn() } }));
vi.mock('@/lib/api', () => ({ api: { users: { setActivities: vi.fn(), clearActivities: vi.fn() } } }));

import { api } from '@/lib/api';
import { desktop } from '@/lib/native';
import { useData } from '@/stores/data';
import { useUI } from '@/stores/ui';
import { currentGame, pollGameActivity, resetGameActivity, startGameDetection, stopGameDetection } from './gameActivity';

const d = vi.mocked(desktop);
const setActivities = vi.mocked(api.users.setActivities);
const clearActivities = vi.mocked(api.users.clearActivities);

beforeEach(async () => {
  vi.useRealTimers();
  d.available.mockReturnValue(true);
  d.listRunningGames.mockReset().mockResolvedValue({ games: [], processes: [] });
  setActivities.mockReset().mockResolvedValue({ activities: [{ type: 'playing', name: 'Dota 2', startedAt: '2024-01-01T00:00:00.000Z' }] } as never);
  clearActivities.mockReset().mockResolvedValue(undefined as never);
  useData.setState({ me: { id: 'u1' } as never, activities: {} });
  await resetGameActivity();
  stopGameDetection();
});
afterEach(() => { stopGameDetection(); vi.useRealTimers(); });

describe('gameActivity', () => {
  it('sets "Playing <game>" when a game starts and clears it when it stops', async () => {
    d.listRunningGames.mockResolvedValue({ games: [{ name: 'Dota 2', executable: 'dota2' }], processes: ['dota2'] });
    await pollGameActivity([], true);
    expect(setActivities).toHaveBeenCalledWith([{ type: 'playing', name: 'Dota 2' }]);
    expect(currentGame()?.name).toBe('Dota 2');
    expect(useData.getState().activities.u1?.[0]?.name).toBe('Dota 2');

    // the same game on the next pass must not re-send the activity
    await pollGameActivity([], true);
    expect(setActivities).toHaveBeenCalledTimes(1);

    d.listRunningGames.mockResolvedValue({ games: [], processes: [] });
    await pollGameActivity([], true);
    expect(clearActivities).toHaveBeenCalledTimes(1);
    expect(currentGame()).toBeNull();
    expect(useData.getState().activities.u1).toEqual([]);
  });

  it('switches the activity when a different game starts', async () => {
    d.listRunningGames.mockResolvedValue({ games: [{ name: 'Dota 2', executable: 'dota2' }], processes: [] });
    await pollGameActivity([], true);
    d.listRunningGames.mockResolvedValue({ games: [{ name: 'Minecraft', executable: 'minecraftlauncher' }], processes: [] });
    await pollGameActivity([], true);
    expect(setActivities).toHaveBeenLastCalledWith([{ type: 'playing', name: 'Minecraft' }]);
    expect(currentGame()?.name).toBe('Minecraft');
  });

  it('does nothing outside Tauri', async () => {
    d.available.mockReturnValue(false);
    d.listRunningGames.mockResolvedValue({ games: [{ name: 'Dota 2', executable: 'dota2' }], processes: [] });
    await pollGameActivity([], true);
    expect(d.listRunningGames).not.toHaveBeenCalled();
    expect(setActivities).not.toHaveBeenCalled();
    expect(currentGame()).toBeNull();
  });

  it('clears the activity when detection is disabled', async () => {
    d.listRunningGames.mockResolvedValue({ games: [{ name: 'Dota 2', executable: 'dota2' }], processes: [] });
    await pollGameActivity([], true);
    expect(currentGame()).not.toBeNull();
    await pollGameActivity([], false);
    expect(clearActivities).toHaveBeenCalled();
    expect(currentGame()).toBeNull();
  });

  it('leaves a manual activity alone when we never reported a game', async () => {
    await resetGameActivity();
    expect(clearActivities).not.toHaveBeenCalled();
  });

  it('polls on an interval and reads the live preferences', async () => {
    vi.useFakeTimers();
    useUI.setState((s) => ({ prefs: { ...s.prefs, registeredGames: [{ name: 'Foo', executables: ['foo'] }] } }));
    const stop = startGameDetection(1000);
    expect(d.listRunningGames).toHaveBeenCalledWith([{ name: 'Foo', executables: ['foo'] }]);
    const first = d.listRunningGames.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(d.listRunningGames.mock.calls.length).toBeGreaterThan(first);
    stop();
    const after = d.listRunningGames.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(d.listRunningGames.mock.calls.length).toBe(after);
  });
});
