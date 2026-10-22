import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComponentType as CT, MessageFlags } from '@jorcord/shared';
import type { Component, Message } from '@jorcord/shared';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/lib/api', () => ({ api: { interactions: { send: vi.fn().mockResolvedValue({ id: 'ix' }) } } }));
import { api } from '@/lib/api';
import { ComponentsV2, isComponentsV2, resolveMedia } from './ComponentsV2';
import { useData } from '@/stores/data';
import { useMessages } from '@/stores/messages';
import { usePlatform } from '@/stores/platform';
import { useUI } from '@/stores/ui';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const user = (id: string, o: Record<string, unknown> = {}) => ({ id, username: id, displayName: id, avatar: null, banner: null, accentColor: null, bio: null, pronouns: null, bot: false, createdAt: '', ...o });
const text = (content: string): Component => ({ type: CT.TEXT_DISPLAY, content });
const msg = (components: Component[], o: Partial<Message> = {}): Message => ({ id: 'm1', channelId: 'ch', guildId: null, author: user('bot1', { bot: true }), content: '', createdAt: new Date().toISOString(), editedAt: null, type: 'default', replyTo: null, mentions: [], mentionRoles: [], mentionEveryone: false, attachments: [], embeds: [], reactions: [], pinned: false, stickerIds: [], threadId: null, applicationId: 'app1', flags: MessageFlags.IS_COMPONENTS_V2, components, ...o });

let host: HTMLDivElement; let root: Root;
const render = async (el: React.ReactElement) => { await act(async () => { root.render(<MemoryRouter>{el}</MemoryRouter>); }); };
const q = (sel: string) => host.querySelector(sel); const qa = (sel: string) => [...host.querySelectorAll(sel)];

beforeEach(() => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  useData.setState({ me: user('me') as never, users: { me: user('me'), bot1: user('bot1', { bot: true }) } as never, dms: { ch: { id: 'ch', guildId: null, type: 'dm', recipients: [user('me')] } as never } });
  usePlatform.getState().reset(); useMessages.setState({ ch: {}, pending: [] }); useUI.setState({ modal: null });
  vi.mocked(api.interactions.send).mockClear();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('Components V2 renderer', () => {
  it('draws container, section with thumbnail, text, gallery, separator and buttons', async () => {
    const m = msg([
      { type: CT.CONTAINER, accentColor: 0x5865f2, components: [
        { type: CT.SECTION, components: [text('**Title**'), text('body')], accessory: { type: CT.THUMBNAIL, media: { url: 'https://example.com/t.png' }, description: 'thumb' } },
        { type: CT.SEPARATOR, divider: true, spacing: 2 },
        { type: CT.MEDIA_GALLERY, items: [{ media: { url: 'https://example.com/a.png' }, description: 'a' }, { media: { url: 'https://example.com/b.png' }, spoiler: true }] },
        { type: CT.ACTION_ROW, components: [{ type: CT.BUTTON, style: 1, label: 'Go', customId: 'go' }] },
      ] },
      text('outside'),
    ]);
    await render(<ComponentsV2 m={m} />);
    expect(q('[data-v2="container"]')).toBeTruthy(); expect((q('[data-v2="container"]') as HTMLElement).style.borderInlineStartColor).not.toBe('');
    expect(qa('[data-v2="text"]')).toHaveLength(3); expect(q('[data-v2="section"] img')?.getAttribute('alt')).toBe('thumb');
    expect(q('[data-v2="separator"]')).toBeTruthy(); expect(qa('[data-v2="gallery"] img')).toHaveLength(2);
    expect(qa('[data-v2="gallery"] button[aria-label]').length).toBe(1); // only the spoilered image has a reveal button
    expect(q('strong')?.textContent).toBe('Title');
  });

  it('a button inside a container sends the interaction', async () => {
    const m = msg([{ type: CT.CONTAINER, components: [{ type: CT.SECTION, components: [text('x')], accessory: { type: CT.BUTTON, style: 2, label: 'Acc', customId: 'acc' } }] }]);
    await render(<ComponentsV2 m={m} />);
    const b = q('[data-custom-id="acc"]') as HTMLButtonElement; expect(b).toBeTruthy();
    await act(async () => { b.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(api.interactions.send).toHaveBeenCalled();
  });

  it('resolves attachment:// references against the message files and renders a file card', async () => {
    const att = { id: 'a1', filename: 'report.zip', contentType: 'application/zip', size: 2048, url: 'https://cdn.test/report.zip', width: null, height: null, spoiler: false };
    const m = msg([{ type: CT.FILE, media: { url: 'attachment://report.zip' } }, { type: CT.FILE, media: { url: 'attachment://gone.zip' } }], { attachments: [att] });
    expect(resolveMedia(m, 'attachment://report.zip')?.size).toBe(2048); expect(resolveMedia(m, 'attachment://nope')).toBeNull(); expect(resolveMedia(m, 'javascript:alert(1)')).toBeNull();
    await render(<ComponentsV2 m={m} />);
    expect(q('[data-v2="file"]')?.textContent).toContain('report.zip'); expect(host.textContent).toContain('File unavailable');
  });

  it('detects the flag', () => { expect(isComponentsV2(msg([]))).toBe(true); expect(isComponentsV2({ flags: 0 })).toBe(false); expect(isComponentsV2({})).toBe(false); });
});
