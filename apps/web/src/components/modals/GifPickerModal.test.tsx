import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/api', () => ({ api: { misc: { gifs: vi.fn() }, users: { gifFavorites: vi.fn() } } }));
import { api } from '@/lib/api';
import { GifPickerModal } from './ModalHost';

const gifs = vi.mocked(api.misc.gifs);
const favs = vi.mocked(api.users.gifFavorites);

const wrap = (el: React.ReactElement) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{el}</QueryClientProvider>;

afterEach(cleanup);
beforeEach(() => {
  gifs.mockReset().mockResolvedValue([{ id: 'g1', url: 'https://media.example/cat.gif', preview: 'https://media.example/cat-preview.gif', title: 'Cat' }] as never);
  favs.mockReset().mockResolvedValue([]);
});

describe('GifPickerModal', () => {
  it('opens straight on the GIF tab (no emoji/sticker switcher) and hands the picked GIF URL to onPick', async () => {
    const onPick = vi.fn(); const close = vi.fn();
    render(wrap(<GifPickerModal onPick={onPick} close={close} />));
    expect(screen.getByText('Choose a GIF')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'GIF picker' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Emoji' })).toBeNull(); // tab switcher hidden in gif-only mode
    expect((screen.getByLabelText('Search') as HTMLInputElement).placeholder).toBe('Search GIFs');
    const gif = await screen.findByRole('button', { name: 'Cat' });
    expect(gifs).toHaveBeenCalledWith(undefined);
    fireEvent.click(gif);
    await waitFor(() => expect(onPick).toHaveBeenCalledWith('https://media.example/cat.gif'));
    expect(close).toHaveBeenCalled();
  });

  it('shows saved GIF favorites', async () => {
    favs.mockResolvedValue([{ id: 'f1', url: 'https://media.example/fav.gif', preview: null, title: 'Fav' }] as never);
    render(wrap(<GifPickerModal onPick={vi.fn()} close={vi.fn()} />));
    fireEvent.click(await screen.findByRole('tab', { name: 'Favorites' }));
    expect(await screen.findByRole('button', { name: 'Fav' })).toBeTruthy();
    expect(favs).toHaveBeenCalled();
  });

  it('ignores a pick that carries no GIF URL', async () => {
    const onPick = vi.fn(); const close = vi.fn();
    render(wrap(<GifPickerModal onPick={onPick} close={close} />));
    await screen.findByRole('button', { name: 'Cat' });
    fireEvent.click(screen.getByRole('tab', { name: 'Favorites' }));
    await screen.findByText('No favorites yet. Star a GIF, or right-click an image in chat.');
    expect(onPick).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
  });
});
