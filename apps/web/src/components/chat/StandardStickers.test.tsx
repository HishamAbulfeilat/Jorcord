import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useData } from '@/stores/data';

vi.mock('@/lib/api', () => ({ api: { misc: { gifs: vi.fn().mockResolvedValue([]) }, users: { gifFavorites: vi.fn().mockResolvedValue([]) } } }));
vi.mock('@/lib/nav', () => ({ useNav: () => ({ go: vi.fn() }) }));
import { EmojiPicker } from './EmojiPicker';

afterEach(cleanup);
const wrap = (ui: React.ReactNode) => <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;

describe('standard stickers in the picker', () => {
  it('offers the built-in packs even without a server (DMs) and picks by id', () => {
    useData.setState({ guilds: {}, guildOrder: [], me: null } as never);
    const onPick = vi.fn();
    render(wrap(<EmojiPicker allowSticker initialTab="sticker" onPick={onPick} />));
    expect(screen.getByRole('region', { name: 'Reactions' })).toBeTruthy();
    fireEvent.click(screen.getByLabelText('GG'));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ sticker: 'std_gg', name: 'GG' }));
  });
  it('filters stickers by the search text', () => {
    useData.setState({ guilds: {}, guildOrder: [], me: null } as never);
    render(wrap(<EmojiPicker allowSticker initialTab="sticker" onPick={vi.fn()} />));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'thanks' } });
    expect(screen.getByLabelText('Thanks')).toBeTruthy();
    expect(screen.queryByLabelText('GG')).toBeNull();
  });
});
