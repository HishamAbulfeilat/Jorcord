import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/native', () => ({ desktop: { available: vi.fn(), listRunningGames: vi.fn() } }));
vi.mock('@/lib/gameActivity', () => ({ resetGameActivity: vi.fn() }));

import { desktop } from '@/lib/native';
import { resetGameActivity } from '@/lib/gameActivity';
import { useUI } from '@/stores/ui';
import { RegisteredGamesTab } from './RegisteredGamesTab';

const d = vi.mocked(desktop);
const reset = vi.mocked(resetGameActivity);

beforeEach(() => {
  d.available.mockReturnValue(true);
  d.listRunningGames.mockReset().mockResolvedValue({ games: [{ name: 'Dota 2', executable: 'dota2' }], processes: ['dota2', 'chrome'] });
  reset.mockReset();
  useUI.setState((s) => ({ prefs: { ...s.prefs, gameActivity: true, registeredGames: [{ name: 'Minecraft', executables: ['minecraftlauncher'] }] } }));
});
afterEach(cleanup);

describe('RegisteredGamesTab', () => {
  it('lists registered games and the games detected right now', async () => {
    render(<RegisteredGamesTab />);
    expect(screen.getByText('Minecraft')).toBeTruthy();
    expect(d.listRunningGames).toHaveBeenCalledWith([{ name: 'Minecraft', executables: ['minecraftlauncher'] }]);
    expect(await screen.findByText('Dota 2')).toBeTruthy();
  });

  it('turns off "display current activity" and clears the activity', () => {
    render(<RegisteredGamesTab />);
    fireEvent.click(screen.getByRole('switch', { name: 'Display current activity' }));
    expect(useUI.getState().prefs.gameActivity).toBe(false);
    expect(reset).toHaveBeenCalled();
  });

  it('registers a running program as a game', async () => {
    render(<RegisteredGamesTab />);
    await screen.findByRole('option', { name: 'dota2' });
    fireEvent.change(screen.getByLabelText('Running program'), { target: { value: 'dota2' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Dota 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add game' }));
    await waitFor(() => expect(useUI.getState().prefs.registeredGames).toEqual([
      { name: 'Minecraft', executables: ['minecraftlauncher'] },
      { name: 'Dota 2', executables: ['dota2'] },
    ]));
  });

  it('hides detection outside the desktop app', () => {
    d.available.mockReturnValue(false);
    render(<RegisteredGamesTab />);
    expect(screen.getByText('Game detection is only available in the desktop app.')).toBeTruthy();
    expect(d.listRunningGames).not.toHaveBeenCalled();
  });
});
