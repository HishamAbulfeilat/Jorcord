import { z } from 'zod';
import { LIMITS, type Embed } from '@jorcord/shared';
import { ApiError } from '../errors';
import { externalUrl } from './ids';

/**
 * Validation for sender-sent rich embeds (bots and webhooks; see CONTRACT.md).
 * Discord's public numbers: 10 embeds per message, title 256 / description 4096 /
 * author 256 / footer 2048, 25 fields with name 256 + value 1024, 6000 chars total.
 */
const color = z.number().int().min(0).max(0xffffff);
const field = z.object({ name: z.string().min(1).max(256), value: z.string().min(1).max(1024), inline: z.boolean().optional() }).strict();

const embedBody = z.object({
  type: z.literal('rich').optional(),
  url: z.string().max(512).refine((s) => /^https?:\/\//.test(s), 'url must be an absolute http(s) URL').optional(),
  title: z.string().min(1).max(256).optional(),
  description: z.string().min(1).max(4096).optional(),
  color: color.optional(),
  thumbnail: externalUrl.optional(),
  image: externalUrl.optional(),
  fields: z.array(field).max(25).optional(),
  footer: z.string().min(1).max(2048).optional(),
  author: z.string().min(1).max(256).optional(),
}).strict();

const fail = (message: string, details?: unknown) => new ApiError(400, 'INVALID_EMBEDS', message, details).num(50035);

/**
 * Validates and normalises a sender-sent embeds array. Users cannot send embeds at all
 * (403 `USER_FORBIDDEN`, errorCode 20002 — same rule as components); bots get 400
 * `INVALID_EMBEDS` / errorCode 50035 on bad structure.
 */
export function parseEmbeds(input: unknown, isBot: boolean): Embed[] {
  if (input === undefined) return [] as unknown as Embed[];
  if (!isBot) throw new ApiError(403, 'USER_FORBIDDEN', 'Only bots can send embeds').num(20002);
  const parsed = z.array(embedBody).min(1).max(LIMITS.maxEmbedsPerMessage).safeParse(input);
  if (!parsed.success) throw fail('Invalid embeds', parsed.error.flatten());
  let total = 0;
  const out: Embed[] = parsed.data.map((e) => {
    const fields = e.fields?.length ? e.fields : undefined;
    if (!e.title && !e.description && !fields && !e.image) throw fail('Embed must have a title, description, image or fields');
    total += (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.length ?? 0) + (e.author?.length ?? 0)
      + (fields?.reduce((n, f) => n + f.name.length + f.value.length, 0) ?? 0);
    return { type: 'rich', url: e.url, title: e.title, description: e.description, color: e.color, thumbnail: e.thumbnail, image: e.image, fields, footer: e.footer, author: e.author };
  });
  if (total > 6000) throw fail(`Embeds exceed the ${6000} character limit (got ${total})`);
  return out;
}
