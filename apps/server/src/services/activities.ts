import { z } from 'zod';
import { MAX_ACTIVITIES, type Activity } from '@jorcord/shared';
import { assetUrl, idSchema } from '../lib/ids';

const text = (n: number) => z.string().trim().max(n);
export const activitySchema = z.object({
  type: z.enum(['playing', 'streaming', 'listening', 'watching', 'competing']),
  name: z.string().trim().min(1).max(128),
  details: text(128).nullable().optional(), state: text(128).nullable().optional(),
  url: assetUrl.nullable().optional().refine((v) => !v || /^https?:\/\//.test(v), 'url must be http(s)'),
  startedAt: z.string().datetime({ offset: true }).optional(),
  applicationId: idSchema.nullable().optional(),
  largeImage: assetUrl.nullable().optional(), smallImage: assetUrl.nullable().optional(),
}).strict();
export const activitiesSchema = z.array(activitySchema).max(MAX_ACTIVITIES);

/** Fills defaults: `startedAt` = now (never in the future, never older than a day), unset optionals -> null. */
export function normalizeActivities(list: z.infer<typeof activitiesSchema>): Activity[] {
  const now = Date.now();
  return list.map((a) => {
    const t = a.startedAt ? Date.parse(a.startedAt) : now;
    return {
      type: a.type, name: a.name, details: a.details || null, state: a.state || null, url: a.type === 'streaming' ? a.url ?? null : null,
      startedAt: new Date(Math.min(now, Math.max(now - 86_400_000, t))).toISOString(), applicationId: a.applicationId ?? null, largeImage: a.largeImage ?? null, smallImage: a.smallImage ?? null,
    };
  });
}
