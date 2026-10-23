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

describe('external stickers in the picker', () => {
  const g = (id: string, name: string, stickers: { id: string; name: string }[]) => ({ guild: { id, name, ownerId: 'x' }, roles: [], members: {}, emojis: [], channels: {}, stickers: stickers.map((s) => ({ ...s, guildId: id, url: `/files/${s.id}.png`, format: 'png' })) });
  const seed = () => useData.setState({ guilds: { a: g('a', 'Alpha', [{ id: '1', name: 'Own' }]), b: g('b', 'Beta', [{ id: '2', name: 'Foreign' }]), c: g('c', 'Gamma', []) }, guildOrder: ['a', 'b', 'c'], me: null } as never);
  it('groups other servers stickers under their name and lets them be picked with the permission', () => {
    seed(); const onPick = vi.fn();
    render(wrap(<EmojiPicker allowSticker guildId="a" initialTab="sticker" externalStickers onPick={onPick} />));
    expect(screen.getByRole('region', { name: 'Beta' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Gamma' })).toBeNull();
    fireEvent.click(screen.getByLabelText('Foreign'));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ sticker: '2' }));
  });
  it('disables them with a hint without the permission, own stickers stay enabled', () => {
    seed(); const onPick = vi.fn();
    render(wrap(<EmojiPicker allowSticker guildId="a" initialTab="sticker" externalStickers={false} onPick={onPick} />));
    const f = screen.getByLabelText('Foreign') as HTMLButtonElement;
    expect(f.disabled).toBe(true);
    expect(screen.getByText(/Use External Stickers permission/)).toBeTruthy();
    fireEvent.click(f); expect(onPick).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Own') as HTMLButtonElement).disabled).toBe(false);
  });
});
