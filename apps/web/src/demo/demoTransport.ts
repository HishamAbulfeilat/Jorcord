import { snowflake } from '@jorcord/shared';
import type { Message } from '@jorcord/shared';
import type { Transport } from '@/lib/transport';
import { messagesByChannel, demoReady } from './mockData';
import { compareId } from '@/lib/format';

/** Offline stub that answers just enough of the contract for the demo UI. */
export const demoTransport: Transport = async (req) => {
  const { method, path } = req; let m: RegExpMatchArray | null;
  if (method === 'GET' && (m = path.match(/^\/channels\/(\d+)\/messages$/))) {
    const limit = Number(req.query?.limit ?? 50); const before = req.query?.before as string | undefined;
    let list = messagesByChannel[m[1]] ?? [];
    if (before) list = list.filter((x) => compareId(x.id, before) < 0);
    return [...list.slice(-limit)].reverse();
  }
  if (method === 'POST' && (m = path.match(/^\/channels\/(\d+)\/messages$/))) {
    const body = (req.body ?? {}) as { content?: string; replyTo?: string };
    const files = req.form ? (req.form.getAll('files[]') as File[]) : [];
    const msg: Message = {
      id: snowflake(), channelId: m[1], guildId: m[1].startsWith('4') ? '2001' : null, author: demoReady.user, content: body.content ?? String(req.form?.get('content') ?? ''), createdAt: new Date().toISOString(), editedAt: null,
      type: body.replyTo ? 'reply' : 'default', replyTo: body.replyTo ?? null, referenced: null, mentions: [], mentionRoles: [], mentionEveryone: false,
      attachments: files.map((f, i) => ({ id: 'f' + i + Date.now(), filename: f.name, contentType: f.type, size: f.size, url: URL.createObjectURL(f), width: null, height: null, spoiler: false })),
      embeds: [], reactions: [], pinned: false, stickerIds: [], threadId: null,
    };
    (messagesByChannel[m[1]] ??= []).push(msg);
    return msg;
  }
  if (method === 'GET' && (m = path.match(/^\/channels\/(\d+)\/pins$/))) return (messagesByChannel[m[1]] ?? []).filter((x) => x.pinned);
  if (method === 'GET' && (m = path.match(/^\/users\/(\d+)$/))) { const u = demoReady.guilds[0].members.find((x) => x.user.id === m![1])?.user ?? demoReady.user; return { ...u, mutualGuilds: [{ id: '2001', name: 'Jorcord HQ', icon: null }, { id: '2002', name: 'Pixel Pals', icon: null }] }; }
  if (method === 'GET' && path === '/guilds/discover') return [];
  if (method === 'GET') return [];
  return {};
};
