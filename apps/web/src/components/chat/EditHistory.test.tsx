import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@jorcord/shared';

vi.mock('@/lib/api', () => ({ api: { messages: { editHistory: vi.fn().mockResolvedValue([]) } } }));
import { api } from '@/lib/api';
import { EditHistoryPopover } from './MessageList';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const user = (id: string, o: Record<string, unknown> = {}) => ({ id, username: id, displayName: id, avatar: null, banner: null, accentColor: null, bio: null, pronouns: null, bot: false, createdAt: '', ...o });
const msg = (o: Partial<Message> = {}): Message => ({ id: 'm1', channelId: 'ch', guildId: null, author: user('alice'), content: '', createdAt: new Date().toISOString(), editedAt: new Date().toISOString(), type: 'default', replyTo: null, mentions: [], mentionRoles: [], mentionEveryone: false, attachments: [], embeds: [], reactions: [], pinned: false, stickerIds: [], threadId: null, ...o });
const edits = [{ id: 'e2', messageId: 'm1', content: 'v2 **bold**', editedAt: new Date(Date.now() - 1000).toISOString() }, { id: 'e1', messageId: 'm1', content: 'v1', editedAt: new Date(Date.now() - 2000).toISOString() }];
const target = (m: Message) => ({ m, rect: new DOMRect(200, 100, 50, 16) });

let host: HTMLDivElement; let root: Root;
const render = async (el: React.ReactElement) => { await act(async () => { root.render(el); }); };
const click = async (el: Element | null) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })); }); };
const q = (sel: string) => host.querySelector(sel);

beforeEach(() => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  vi.mocked(api.messages.editHistory).mockClear().mockResolvedValue(edits);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('edit history popover (R19)', () => {
  it('fetches prior versions for the message and lists them newest first', async () => {
    await render(<EditHistoryPopover target={target(msg())} onClose={() => {}} />);
    expect(api.messages.editHistory).toHaveBeenCalledWith('ch', 'm1');
    expect(q('[data-testid=edit-history-loading]')).toBeNull(); // resolved
    const versions = [...host.querySelectorAll('[data-testid=edit-history-version]')];
    expect(versions).toHaveLength(2);
    expect(versions[0]!.textContent).toContain('v2 bold'); // markdown is shown plain
    expect(versions[1]!.textContent).toContain('v1');
  });

  it('says so when the message has no history and still offers a close button', async () => {
    vi.mocked(api.messages.editHistory).mockResolvedValue([]);
    let closed = false;
    await render(<EditHistoryPopover target={target(msg())} onClose={() => { closed = true; }} />);
    expect(q('[data-testid=edit-history-empty]')).toBeTruthy();
    await click(q('[aria-label=Close]'));
    expect(closed).toBe(true);
  });
});
