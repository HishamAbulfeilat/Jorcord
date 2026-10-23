import { Perm, has } from '@jorcord/shared';
import type { Ctx } from '../../ctx';
import { badRequest, forbidden } from '../../errors';
import { audit } from '../guilds';
import { createMessage } from '../messages';
import { botOutputBlocked } from '../automod';
import { loadGuildPerm, needOutrank } from '../perms';
import { memberDTO } from '../serializers';
import { bool, channelOpt, roleOpt, str, sub, type CmdCtx, type SysBot } from './kit';

export const DEFAULT_WELCOME = 'Welcome to {server}, {user}! You are member #{count}.';
export interface WelcomeConfig { enabled?: boolean; channelId?: string | null; message?: string; roleId?: string | null }

/** Roles a join automation may never hand out: whoever configured it must not be able to mint moderators through it. */
export const DANGEROUS_ROLE_PERMS = Perm.ADMINISTRATOR | Perm.MANAGE_GUILD | Perm.MANAGE_ROLES | Perm.MANAGE_CHANNELS | Perm.KICK_MEMBERS | Perm.BAN_MEMBERS
  | Perm.MODERATE_MEMBERS | Perm.MANAGE_MESSAGES | Perm.MANAGE_WEBHOOKS | Perm.MENTION_EVERYONE;

export async function getConfig(ctx: Ctx, guildId: string): Promise<WelcomeConfig> {
  const [r] = await ctx.db.query(`SELECT config FROM system_bot_settings WHERE guild_id = $1 AND bot_key = 'welcome'`, [guildId]);
  return (r?.config as WelcomeConfig) ?? {};
}
async function setConfig(ctx: Ctx, guildId: string, userId: string, patch: WelcomeConfig) {
  const cur = await getConfig(ctx, guildId);
  await ctx.db.query(
    `INSERT INTO system_bot_settings (guild_id, bot_key, config, updated_by) VALUES ($1,'welcome',$2::jsonb,$3)
     ON CONFLICT (guild_id, bot_key) DO UPDATE SET config = EXCLUDED.config, updated_by = EXCLUDED.updated_by, updated_at = now()`, [guildId, JSON.stringify({ ...cur, ...patch }), userId]);
}

const render = (tpl: string, v: { user: string; username: string; server: string; count: number }) =>
  tpl.replaceAll('{user}', `<@${v.user}>`).replaceAll('{username}', v.username).replaceAll('{server}', v.server).replaceAll('{count}', String(v.count));

async function resolveChannel(ctx: Ctx, guildId: string, cfg: WelcomeConfig, systemChannelId: string | null) {
  for (const id of [cfg.channelId, systemChannelId]) {
    if (!id) continue;
    const [c] = await ctx.db.query(`SELECT * FROM channels WHERE id = $1 AND guild_id = $2 AND type IN ('text','announcement')`, [id, guildId]);
    if (c) return c;
  }
  return null;
}

/** Sends the welcome message and applies the auto-role for a member who just joined. */
export async function greetNewMember(ctx: Ctx, app: any, guildId: string, userId: string): Promise<void> {
  const cfg = await getConfig(ctx, guildId);
  if (cfg.enabled === false) return;
  const [g] = await ctx.db.query('SELECT name, system_channel_id FROM guilds WHERE id = $1', [guildId]);
  const [u] = await ctx.db.query('SELECT username, display_name, bot FROM users WHERE id = $1', [userId]);
  if (!g || !u || u.bot) return; // bots (including this one) are not welcomed
  if (cfg.roleId) await applyAutoRole(ctx, app, guildId, userId, cfg.roleId);
  const channel = await resolveChannel(ctx, guildId, cfg, g.system_channel_id ?? null);
  if (!channel) return;
  const [n] = await ctx.db.query('SELECT count(*)::int AS n FROM members WHERE guild_id = $1', [guildId]);
  const content = render(cfg.message || DEFAULT_WELCOME, { user: userId, username: u.display_name ?? u.username, server: g.name, count: n.n });
  if (await botOutputBlocked(ctx, guildId, content, [channel.id, ...(channel.parent_id ? [channel.parent_id] : [])])) return; // e.g. a username that trips a word filter: skip the public greeting
  await createMessage(ctx, { channel, authorId: app.bot_user_id, content: content.slice(0, 2000), applicationId: app.id, senderPerms: 0n, skipChecks: true, allowedMentions: { parse: [], users: [userId] } });
}

async function applyAutoRole(ctx: Ctx, app: any, guildId: string, userId: string, roleId: string) {
  const [role] = await ctx.db.query('SELECT * FROM roles WHERE id = $1 AND guild_id = $2 AND id <> $2', [roleId, guildId]);
  if (!role || role.managed_app_id || role.managed_kind) return; // deleted, or turned into an integration/booster role since
  if ((BigInt(role.permissions) & DANGEROUS_ROLE_PERMS) !== 0n) return; // re-checked at use time: the role may have been upgraded since it was configured
  await ctx.db.query('INSERT INTO member_roles (guild_id, user_id, role_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [guildId, userId, roleId]);
  await ctx.pcache.invalidate({ k: 'member', guildId, userId });
  await audit(ctx, guildId, app.bot_user_id, 'MEMBER_ROLE_UPDATE', userId, { added: [roleId], by: 'welcome-bot' });
  const m = await memberDTO(ctx, guildId, userId);
  if (m) await ctx.hub.toGuild(guildId, 'MEMBER_UPDATE', m);
}

async function showConfig(c: CmdCtx) {
  const cfg = await getConfig(c.ctx, c.guildId);
  const [g] = await c.ctx.db.query('SELECT system_channel_id FROM guilds WHERE id = $1', [c.guildId]);
  const ch = cfg.channelId ?? g?.system_channel_id;
  await c.reply([
    `Welcome messages are ${cfg.enabled === false ? 'off' : 'on'}.`,
    `Channel: ${ch ? `<#${ch}>` : 'none (set one with /welcome channel)'}${cfg.channelId ? '' : ' (server default)'}`,
    `Auto-role: ${cfg.roleId ? `<@&${cfg.roleId}>` : 'none'}`,
    `Message: ${cfg.message || DEFAULT_WELCOME}`,
    'Variables: {user} {username} {server} {count}',
  ].join('\n'));
}

export const welcomeBot: SysBot = {
  key: 'welcome', name: 'Welcome', category: 'community', tags: ['welcome', 'autorole', 'official'],
  summary: 'Greets new members and can give them a role automatically.',
  description: 'The official Jorcord welcome bot. Greets every new member with a message you write and can hand out a starter role. Configure it with /welcome.',
  permissions: Perm.VIEW_CHANNEL | Perm.SEND_MESSAGES | Perm.EMBED_LINKS,
  commands: [{
    name: 'welcome', description: 'Configure the welcome message and auto-role', requires: Perm.MANAGE_GUILD, limit: { max: 20, windowMs: 60_000 },
    options: [
      sub('show', 'Show the current welcome settings'),
      sub('message', 'Set the welcome message', [str('text', 'Use {user} {username} {server} {count}', { required: true, maxLength: 1000 })]),
      sub('channel', 'Choose the channel welcome messages are sent to', [channelOpt('channel', 'A text channel', { required: true, channelTypes: ['text', 'announcement'] })]),
      sub('role', 'Give new members this role (leave empty to turn the auto-role off)', [roleOpt('role', 'The starter role')]),
      sub('toggle', 'Turn welcome messages and the auto-role on or off', [bool('enabled', 'On or off', { required: true })]),
      sub('test', 'Preview the welcome message here, as it would look for you'),
    ],
    async run(c) {
      requireManage(c);
      switch (c.sub) {
        case 'show': return showConfig(c);
        case 'message': {
          const text = (c.opt('text') ?? '').trim();
          if (!text) throw badRequest('The message cannot be empty');
          await setConfig(c.ctx, c.guildId, c.userId, { message: text.slice(0, 1000) });
          return c.reply('Welcome message updated.');
        }
        case 'channel': {
          const id = c.opt('channel');
          const [ch] = await c.ctx.db.query(`SELECT id FROM channels WHERE id = $1 AND guild_id = $2 AND type IN ('text','announcement')`, [id, c.guildId]);
          if (!ch) throw badRequest('Choose a text channel of this server');
          await setConfig(c.ctx, c.guildId, c.userId, { channelId: ch.id });
          return c.reply(`Welcome messages will be sent to <#${ch.id}>.`);
        }
        case 'role': {
          const id = c.opt('role');
          if (!id) { await setConfig(c.ctx, c.guildId, c.userId, { roleId: null }); return c.reply('Auto-role turned off.'); }
          await checkAssignable(c, id);
          await setConfig(c.ctx, c.guildId, c.userId, { roleId: id });
          return c.reply(`New members will receive <@&${id}>.`);
        }
        case 'toggle': {
          const on = c.opt<boolean>('enabled') !== false;
          await setConfig(c.ctx, c.guildId, c.userId, { enabled: on });
          return c.reply(`Welcome messages are now ${on ? 'on' : 'off'}.`);
        }
        case 'test': {
          const cfg = await getConfig(c.ctx, c.guildId);
          const [g] = await c.ctx.db.query('SELECT name FROM guilds WHERE id = $1', [c.guildId]);
          const [u] = await c.ctx.db.query('SELECT username, display_name FROM users WHERE id = $1', [c.userId]);
          const [n] = await c.ctx.db.query('SELECT count(*)::int AS n FROM members WHERE guild_id = $1', [c.guildId]);
          return c.reply(render(cfg.message || DEFAULT_WELCOME, { user: c.userId, username: u.display_name ?? u.username, server: g.name, count: n.n }));
        }
        default: throw badRequest('Unknown sub command');
      }
    },
  }],
};

function requireManage(c: CmdCtx) {
  if (!has(c.callerPerms, Perm.MANAGE_GUILD)) throw forbidden('You need the Manage Server permission to configure the welcome bot');
}

/** The configurer must be allowed to hand this role out themselves: Manage Roles and strictly above it in the hierarchy. */
async function checkAssignable(c: CmdCtx, roleId: string) {
  const [role] = await c.ctx.db.query('SELECT * FROM roles WHERE id = $1 AND guild_id = $2', [roleId, c.guildId]);
  if (!role || role.id === c.guildId) throw badRequest('Choose a regular role of this server');
  if (role.managed_app_id || role.managed_kind) throw badRequest('Integration and booster roles cannot be used as the auto-role');
  if (!has(c.callerPerms, Perm.MANAGE_ROLES)) throw forbidden('You need the Manage Roles permission to set the auto-role');
  const caller = (await loadGuildPerm(c.ctx, c.guildId, c.userId))!;
  needOutrank(caller, role.position);
  if ((BigInt(role.permissions) & DANGEROUS_ROLE_PERMS) !== 0n) throw badRequest('That role carries moderation or administration permissions and cannot be handed out automatically');
}
