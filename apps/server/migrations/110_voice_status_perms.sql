-- Voice channel status + new permission bits 47..51 (see PERMS_ADDED_IN_110 in packages/shared/src/permissions.ts).
ALTER TABLE channels ADD COLUMN IF NOT EXISTS voice_status TEXT;
-- Bits: SET_VOICE_CHANNEL_STATUS 1<<47 = 140737488355328, USE_EXTERNAL_SOUNDS 1<<48 = 281474976710656,
-- CREATE_GUILD_EXPRESSIONS 1<<49 = 562949953421312, VIEW_GUILD_INSIGHTS 1<<50 = 1125899906842624, USE_EMBEDDED_ACTIVITIES 1<<51 = 2251799813685248.
-- Source bits: MANAGE_CHANNELS 1<<4 = 16, USE_SOUNDBOARD 1<<37 = 137438953472, MANAGE_EMOJIS 1<<30 = 1073741824, MANAGE_GUILD 1<<5 = 32, CONNECT 1<<20 = 1048576.
-- Roles keep what they could do before: each new bit goes to the holders of the bit it was split from.
UPDATE roles SET permissions = ((permissions::bigint) | 140737488355328::bigint)::text WHERE (permissions::bigint & 16::bigint) <> 0;
UPDATE roles SET permissions = ((permissions::bigint) | 281474976710656::bigint)::text WHERE (permissions::bigint & 137438953472::bigint) <> 0;
UPDATE roles SET permissions = ((permissions::bigint) | 562949953421312::bigint)::text WHERE (permissions::bigint & 1073741824::bigint) <> 0;
UPDATE roles SET permissions = ((permissions::bigint) | 1125899906842624::bigint)::text WHERE (permissions::bigint & 32::bigint) <> 0;
UPDATE roles SET permissions = ((permissions::bigint) | 2251799813685248::bigint)::text WHERE (permissions::bigint & 1048576::bigint) <> 0;
-- Overwrites: an explicit allow/deny of the source bit carries over to the split-out bit.
UPDATE overwrites SET allow = ((allow::bigint) | 140737488355328::bigint)::text WHERE (allow::bigint & 16::bigint) <> 0;
UPDATE overwrites SET allow = ((allow::bigint) | 281474976710656::bigint)::text WHERE (allow::bigint & 137438953472::bigint) <> 0;
UPDATE overwrites SET allow = ((allow::bigint) | 562949953421312::bigint)::text WHERE (allow::bigint & 1073741824::bigint) <> 0;
UPDATE overwrites SET allow = ((allow::bigint) | 1125899906842624::bigint)::text WHERE (allow::bigint & 32::bigint) <> 0;
UPDATE overwrites SET allow = ((allow::bigint) | 2251799813685248::bigint)::text WHERE (allow::bigint & 1048576::bigint) <> 0;
UPDATE overwrites SET deny = ((deny::bigint) | 140737488355328::bigint)::text WHERE (deny::bigint & 16::bigint) <> 0 AND (allow::bigint & 140737488355328::bigint) = 0;
UPDATE overwrites SET deny = ((deny::bigint) | 281474976710656::bigint)::text WHERE (deny::bigint & 137438953472::bigint) <> 0 AND (allow::bigint & 281474976710656::bigint) = 0;
UPDATE overwrites SET deny = ((deny::bigint) | 562949953421312::bigint)::text WHERE (deny::bigint & 1073741824::bigint) <> 0 AND (allow::bigint & 562949953421312::bigint) = 0;
UPDATE overwrites SET deny = ((deny::bigint) | 1125899906842624::bigint)::text WHERE (deny::bigint & 32::bigint) <> 0 AND (allow::bigint & 1125899906842624::bigint) = 0;
UPDATE overwrites SET deny = ((deny::bigint) | 2251799813685248::bigint)::text WHERE (deny::bigint & 1048576::bigint) <> 0 AND (allow::bigint & 2251799813685248::bigint) = 0;
