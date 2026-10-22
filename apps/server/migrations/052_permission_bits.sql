-- New permission bits: PIN_MESSAGES = 1<<44, BYPASS_SLOWMODE = 1<<45, USE_EXTERNAL_STICKERS = 1<<46.
-- Pinning and the slowmode bypass used to ride on MANAGE_MESSAGES / MANAGE_CHANNELS, so existing holders keep them (roles and channel overwrites).
-- @everyone roles (role id = guild id) get USE_EXTERNAL_STICKERS, which is also in DEFAULT_EVERYONE.
-- MANAGE_MESSAGES = 1<<13 = 8192, MANAGE_CHANNELS = 1<<4 = 16.
UPDATE roles SET permissions = ((permissions::bigint) | 17592186044416::bigint)::text
  WHERE (permissions::bigint & 8192::bigint) <> 0;
UPDATE roles SET permissions = ((permissions::bigint) | 35184372088832::bigint)::text
  WHERE (permissions::bigint & (8192::bigint | 16::bigint)) <> 0;
UPDATE roles SET permissions = ((permissions::bigint) | 70368744177664::bigint)::text
  WHERE id = guild_id;
-- Overwrites: an explicit allow of MANAGE_MESSAGES/MANAGE_CHANNELS keeps allowing the split-out bits, an explicit deny keeps denying them.
UPDATE overwrites SET allow = ((allow::bigint) | 17592186044416::bigint)::text WHERE (allow::bigint & 8192::bigint) <> 0;
UPDATE overwrites SET allow = ((allow::bigint) | 35184372088832::bigint)::text WHERE (allow::bigint & (8192::bigint | 16::bigint)) <> 0;
UPDATE overwrites SET deny = ((deny::bigint) | 17592186044416::bigint)::text WHERE (deny::bigint & 8192::bigint) <> 0;
UPDATE overwrites SET deny = ((deny::bigint) | 35184372088832::bigint)::text WHERE (deny::bigint & (8192::bigint | 16::bigint)) <> 0 AND (allow::bigint & 35184372088832::bigint) = 0;
