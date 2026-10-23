/**
 * Built-in official bots. They are ordinary applications (so they install through the same OAuth2 add-bot flow, get a managed role,
 * appear in the App Directory and are removed by kicking the bot), except that their commands run inside this process instead of
 * being delivered to a gateway session or an HTTP endpoint. They have no usable token: `bot_token_hash` is the hash of a secret nobody knows.
 */
import { InteractionType as IT, MessageFlags, has, snowflake, type Interaction } from '@jorcord/shared';
import type { Ctx } from '../../ctx';
import { ApiError, forbidden } from '../../errors';
import { generateAppKeys } from '../../lib/interactionSig';
import { randomToken, sha256 } from '../../lib/crypto';
import { parseCommand } from '../../lib/commands';
import { loadGuildPerm } from '../perms';
import { applyCallback, failInteraction } from '../interactions';
import { isInstalled } from '../apps';
import { botOutputBlocked } from '../automod';
import { isUserFacing, permsIn, type CmdCtx, type SysBot } from './kit';
import { moderationBot } from './moderation';
import { utilityBot, fireDueBotReminders } from './utility';
import { welcomeBot, greetNewMember } from './welcome';

export const SYSTEM_BOTS: SysBot[] = [welcomeBot, moderationBot, utilityBot];
export { fireDueBotReminders };

const OWNER_NAME = 'Jorcord';

async function ensureOwner(ctx: Ctx): Promise<string> {
  const [cur] = await ctx.db.query('SELECT owner_id FROM applications WHERE system_key IS NOT NULL LIMIT 1');
  if (cur) return cur.owner_id;
  const id = snowflake();
  await ctx.db.query(`INSERT INTO users (id, username, display_name, bot, verified, presence) VALUES ($1,$2,$2,true,true,'online')`, [id, OWNER_NAME]);
  return id;
}

/** Idempotent; safe when several nodes boot at once (the unique system_key index decides, the loser re-reads). */
export async function ensureSystemApps(ctx: Ctx): Promise<void> {
  let ownerId: string | null = null;
  for (const bot of SYSTEM_BOTS) {
    let [app] = await ctx.db.query('SELECT * FROM applications WHERE system_key = $1', [bot.key]);
    if (!app) {
      try {
        ownerId ??= await ensureOwner(ctx);
        const id = snowflake(), botId = snowflake(), keys = generateAppKeys(ctx.config.jwtSecret);
        await ctx.db.tx(async (q) => {
          await q.query(`INSERT INTO users (id, username, display_name, bot, verified, presence) VALUES ($1,$2,$2,true,true,'online')`, [botId, bot.name]);
          await q.query(
            `INSERT INTO applications (id, owner_id, name, description, bot_user_id, bot_token_hash, client_secret_hash, public_key, private_key_enc, redirect_uris, bot_public, system_key, directory_listed, directory_listed_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'[]'::jsonb,true,$10,true,now())`,
            [id, ownerId, bot.name, bot.description, botId, sha256(randomToken(32)), sha256(randomToken(32)), keys.publicKey, keys.privateKeyEnc, bot.key]);
        });
      } catch (e) { ctx.log.debug({ err: e }, 'system app creation raced'); }
      [app] = await ctx.db.query('SELECT * FROM applications WHERE system_key = $1', [bot.key]);
      if (!app) throw new Error(`could not create system app ${bot.key}`);
    }
    await ctx.db.query(
      `UPDATE applications SET name = $2, description = $3, bot_public = true, interactions_endpoint_url = NULL, directory_listed = true, directory_category = $4, directory_summary = $5, directory_tags = $6::jsonb, directory_permissions = $7 WHERE id = $1`,
      [app.id, bot.name, bot.description, bot.category, bot.summary, JSON.stringify(bot.tags), bot.permissions.toString()]);
    await ctx.db.query('UPDATE users SET username = $2, display_name = $2 WHERE id = $1', [app.bot_user_id, bot.name]);
    await syncCommands(ctx, app.id, bot);
    ctx.hub.markOnline([app.bot_user_id]); // official bots always show as online
  }
}

async function syncCommands(ctx: Ctx, appId: string, bot: SysBot) {
  const existing = await ctx.db.query(`SELECT * FROM application_commands WHERE application_id = $1 AND scope_key = ''`, [appId]);
  const keep = new Set<string>();
  for (const def of bot.commands) {
    const c = parseCommand({ name: def.name, description: def.description, options: def.options ?? [], defaultMemberPermissions: def.requires ? def.requires.toString() : null, dmPermission: false });
    keep.add(def.name);
    const cur = existing.find((r) => r.name === def.name && r.type === 1);
    if (cur) {
      if (cur.description === c.description && JSON.stringify(cur.options ?? []) === JSON.stringify(c.options) && (cur.default_member_permissions ?? null) === c.defaultMemberPermissions) continue;
      await ctx.db.query('UPDATE application_commands SET description=$2, options=$3::jsonb, default_member_permissions=$4, dm_permission=false, version=$5 WHERE id=$1', [cur.id, c.description, JSON.stringify(c.options), c.defaultMemberPermissions, snowflake()]);
    } else {
      await ctx.db.query(
        `INSERT INTO application_commands (id, application_id, guild_id, scope_key, type, name, description, options, default_member_permissions, dm_permission, nsfw, version)
         VALUES ($1,$2,NULL,'',1,$3,$4,$5::jsonb,$6,false,false,$7)`, [snowflake(), appId, c.name, c.description, JSON.stringify(c.options), c.defaultMemberPermissions, snowflake()]);
    }
  }
  for (const r of existing) if (!keep.has(r.name)) await ctx.db.query('DELETE FROM application_commands WHERE id = $1', [r.id]);
}

// ------------------------------------------------------------------ dispatch
function flatten(options: any[] | undefined) {
  const path: string[] = []; let cur: any[] = options ?? [];
  while (cur.length === 1 && (cur[0].type === 1 || cur[0].type === 2)) { path.push(cur[0].name); cur = cur[0].options ?? []; }
  return { path, values: new Map<string, unknown>(cur.map((o: any) => [o.name, o.value])) };
}

/** Runs a command of a built-in bot. Fire-and-forget: the HTTP request that triggered it already returned 202. */
export function runSystemInteraction(ctx: Ctx, app: any, row: any, payload: Interaction): void {
  void dispatch(ctx, app, row, payload).catch(async (e) => { ctx.log.warn({ err: e, bot: app.system_key }, 'system bot command failed'); await failInteraction(ctx, row.id).catch(() => {}); });
}

async function publicReplyBlocked(ctx: Ctx, row: any, content: string) {
  const [ch] = await ctx.db.query('SELECT parent_id FROM channels WHERE id = $1', [row.channel_id]);
  return botOutputBlocked(ctx, row.guild_id, content, [row.channel_id, ...(ch?.parent_id ? [ch.parent_id] : [])]);
}

async function dispatch(ctx: Ctx, app: any, row: any, payload: Interaction) {
  const bot = SYSTEM_BOTS.find((b) => b.key === app.system_key);
  const def = bot?.commands.find((c) => c.name === payload.data?.name);
  if (!bot || !def || row.type !== IT.APPLICATION_COMMAND || !row.guild_id) return failInteraction(ctx, row.id);
  const reply = async (content: string, o: { ephemeral?: boolean } = {}) => {
    const [fresh] = await ctx.db.query('SELECT * FROM interactions WHERE id = $1', [row.id]);
    let text = content;
    let eph = o.ephemeral !== false;
    if (!eph && (await publicReplyBlocked(ctx, row, content))) { // public output goes through the server's content rules; blocked -> only the caller sees it
      eph = true; text = `${content}\n\n(Not posted publicly: it matches this server's AutoMod rules.)`;
    }
    await applyCallback(ctx, fresh ?? row, { type: 4, data: { content: text.slice(0, 4000), flags: eph ? MessageFlags.EPHEMERAL : 0 } });
  };
  try {
    // the install may have been removed between the click and now
    if (!(await isInstalled(ctx, app.id, row.guild_id))) throw forbidden('This app is no longer installed in this server', 'MISSING_ACCESS');
    const [channel] = await ctx.db.query('SELECT * FROM channels WHERE id = $1 AND guild_id = $2', [row.channel_id, row.guild_id]);
    const caller = await loadGuildPerm(ctx, row.guild_id, row.user_id);
    if (!channel || !caller) throw forbidden('You cannot use this app here');
    const callerPerms = await permsIn(ctx, caller, channel);
    if (def.requires && !has(callerPerms, def.requires)) throw forbidden('You do not have permission to use this command');
    const wait = ctx.rl.hit(`sysbot:${bot.key}:${def.name}:${row.guild_id}:${row.user_id}`, def.limit.max, def.limit.windowMs); // always on, independent of the global rate-limit switch
    if (wait) throw new ApiError(429, 'RATE_LIMITED', `You are using /${def.name} too quickly. Try again in ${wait}s.`);
    const { path, values } = flatten(payload.data?.options as any);
    const c: CmdCtx = {
      ctx, app, interaction: row, userId: row.user_id, guildId: row.guild_id, channel, caller, callerPerms, sub: path.join(' '),
      opt: <T extends string | number | boolean = string>(name: string) => values.get(name) as T | undefined, reply,
    };
    await def.run(c);
  } catch (e) {
    if (isUserFacing(e)) await reply(e.message).catch(() => {});
    else { ctx.log.warn({ err: e, bot: bot.key, command: def.name }, 'system bot command error'); await reply('Something went wrong. Please try again.').catch(() => {}); }
  }
}

// ------------------------------------------------------------------ hooks
/** Called after a member joined a server: greets and auto-roles if the Welcome bot is installed there. Never throws. */
export async function onMemberJoined(ctx: Ctx, guildId: string, userId: string): Promise<void> {
  try {
    const [app] = await ctx.db.query(`SELECT a.* FROM applications a JOIN application_installs i ON i.application_id = a.id AND i.guild_id = $1 WHERE a.system_key = 'welcome'`, [guildId]);
    if (!app) return;
    await greetNewMember(ctx, app, guildId, userId);
  } catch (e) { ctx.log.warn({ err: e, guildId }, 'welcome bot failed'); }
}
