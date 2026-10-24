import { normalizeModSettings, type ModSettings } from '@jorcord/shared';
import type { Ctx } from '../ctx';

/** The server's moderation settings with defaults applied (see `ModSettings` in the shared package). */
export async function loadModSettings(ctx: Ctx, guildId: string): Promise<ModSettings> {
  const [g] = await ctx.db.query('SELECT mod_settings FROM guilds WHERE id = $1', [guildId]);
  return normalizeModSettings(g?.mod_settings);
}
