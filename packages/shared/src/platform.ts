/** Platform types (applications, bots, commands, interactions, components, polls, events, stages, forum tags) and numeric taxonomies. Additive to types.ts. */
import type { Id, User } from './types';

// ---------- numeric error codes (additive: ApiError.code stays a string; ApiError.errorCode is the Discord-style number) ----------
export const ErrorCode = {
  GENERAL: 0,
  UNKNOWN_APPLICATION: 10002, UNKNOWN_CHANNEL: 10003, UNKNOWN_GUILD: 10004, UNKNOWN_INTEGRATION: 10005, UNKNOWN_INVITE: 10006, UNKNOWN_MEMBER: 10007,
  UNKNOWN_MESSAGE: 10008, UNKNOWN_ROLE: 10011, UNKNOWN_TOKEN: 10012, UNKNOWN_USER: 10013, UNKNOWN_EMOJI: 10014, UNKNOWN_WEBHOOK: 10015,
  UNKNOWN_INTERACTION: 10062, UNKNOWN_APPLICATION_COMMAND: 10063, UNKNOWN_GUILD_SCHEDULED_EVENT: 10070, UNKNOWN_STAGE_INSTANCE: 10067,
  UNKNOWN_STICKER: 10060, UNKNOWN_GUILD_SCHEDULED_EVENT_USER: 10071,
  BOTS_CANNOT_USE_ENDPOINT: 20001, ONLY_BOTS_CAN_USE_ENDPOINT: 20002, SLOWMODE_RATE_LIMIT: 20016,
  MAX_GUILDS: 30001, MAX_PINS: 30003, MAX_APPLICATION_COMMANDS: 30032, MAX_REACTIONS: 30010,
  UNAUTHORIZED: 40001, BANNED: 40007, INTERACTION_ALREADY_ACKNOWLEDGED: 40060,
  MISSING_ACCESS: 50001, CANNOT_SEND_TO_USER: 50007, MISSING_PERMISSIONS: 50013, INVALID_TOKEN: 50014, INVALID_FORM_BODY: 50035,
  /** Poll voting blocked (Discord 520000); Jorcord also uses it for votes on an expired/finalized poll. */ POLL_VOTING_BLOCKED: 520000,
  MFA_REQUIRED: 60003, AUTOMOD_BLOCKED: 200000, THREAD_ARCHIVED: 50083, EVENT_ENTITY_MISMATCH: 50091,
} as const;
/** Default numeric code for each string ApiError.code the server emits. Specific call sites may override. */
export const STRING_TO_ERROR_CODE: Record<string, number> = {
  UNAUTHORIZED: ErrorCode.UNAUTHORIZED, INVALID_TOKEN: ErrorCode.INVALID_TOKEN, FORBIDDEN: ErrorCode.MISSING_PERMISSIONS, HIERARCHY: ErrorCode.MISSING_PERMISSIONS,
  VALIDATION_ERROR: ErrorCode.INVALID_FORM_BODY, BAD_REQUEST: ErrorCode.INVALID_FORM_BODY, SLOWMODE: ErrorCode.SLOWMODE_RATE_LIMIT, MAX_GUILDS: ErrorCode.MAX_GUILDS,
  MAX_PINS: ErrorCode.MAX_PINS, MAX_REACTIONS: ErrorCode.MAX_REACTIONS, BANNED: ErrorCode.BANNED, BLOCKED: ErrorCode.CANNOT_SEND_TO_USER,
  MFA_REQUIRED: ErrorCode.MFA_REQUIRED, AUTOMOD_BLOCKED: ErrorCode.AUTOMOD_BLOCKED, RATE_LIMITED: ErrorCode.GENERAL,
  BOT_FORBIDDEN: ErrorCode.BOTS_CANNOT_USE_ENDPOINT, INTERACTION_ACKNOWLEDGED: ErrorCode.INTERACTION_ALREADY_ACKNOWLEDGED,
};
/** `notFound('<Thing>')` -> numeric code. */
export const NOT_FOUND_ERROR_CODE: Record<string, number> = {
  Application: ErrorCode.UNKNOWN_APPLICATION, Channel: ErrorCode.UNKNOWN_CHANNEL, Guild: ErrorCode.UNKNOWN_GUILD, Invite: ErrorCode.UNKNOWN_INVITE, Member: ErrorCode.UNKNOWN_MEMBER,
  Message: ErrorCode.UNKNOWN_MESSAGE, Role: ErrorCode.UNKNOWN_ROLE, User: ErrorCode.UNKNOWN_USER, Emoji: ErrorCode.UNKNOWN_EMOJI, Webhook: ErrorCode.UNKNOWN_WEBHOOK,
  Interaction: ErrorCode.UNKNOWN_INTERACTION, Command: ErrorCode.UNKNOWN_APPLICATION_COMMAND, 'Scheduled event': ErrorCode.UNKNOWN_GUILD_SCHEDULED_EVENT,
  'Stage instance': ErrorCode.UNKNOWN_STAGE_INSTANCE, Sticker: ErrorCode.UNKNOWN_STICKER,
};
/** Discord-style field error tree: `{ "answers.0.text": { _errors: [{ code, message }] } }` (flat dotted paths). */
export type FieldErrors = Record<string, { _errors: { code: string; message: string }[] }>;

// ---------- audit log numeric action types (values follow Discord's public audit-log table where an equivalent exists) ----------
export const AuditActionType = {
  GUILD_UPDATE: 1, CHANNEL_CREATE: 10, CHANNEL_UPDATE: 11, CHANNEL_DELETE: 12, OVERWRITE_UPDATE: 14, OVERWRITE_DELETE: 15, CHANNEL_REORDER: 16,
  MEMBER_KICK: 20, MEMBER_PRUNE: 21, MEMBER_BAN_ADD: 22, MEMBER_BAN_REMOVE: 23, MEMBER_UPDATE: 24, MEMBER_ROLE_UPDATE: 25, MEMBER_MOVE: 26, MEMBER_DISCONNECT: 27, BOT_ADD: 28,
  MEMBER_TIMEOUT: 29, ROLE_CREATE: 30, ROLE_UPDATE: 31, ROLE_DELETE: 32, ROLE_REORDER: 33, INVITE_CREATE: 40, INVITE_DELETE: 42,
  WEBHOOK_CREATE: 50, WEBHOOK_UPDATE: 51, WEBHOOK_DELETE: 52, EMOJI_CREATE: 60, EMOJI_UPDATE: 61, EMOJI_DELETE: 62,
  MESSAGE_DELETE: 72, MESSAGE_BULK_DELETE: 73, MESSAGE_PIN: 74, MESSAGE_UNPIN: 75, INTEGRATION_CREATE: 80, INTEGRATION_UPDATE: 81, INTEGRATION_DELETE: 82,
  STAGE_INSTANCE_CREATE: 83, STAGE_INSTANCE_UPDATE: 84, STAGE_INSTANCE_DELETE: 85, STICKER_CREATE: 90, STICKER_UPDATE: 91, STICKER_DELETE: 92,
  GUILD_SCHEDULED_EVENT_CREATE: 100, GUILD_SCHEDULED_EVENT_UPDATE: 101, GUILD_SCHEDULED_EVENT_DELETE: 102, THREAD_CREATE: 110, THREAD_UPDATE: 111, THREAD_DELETE: 112,
  APPLICATION_COMMAND_PERMISSION_UPDATE: 121, AUTOMOD_RULE_CREATE: 140, AUTOMOD_RULE_UPDATE: 141, AUTOMOD_RULE_DELETE: 142, AUTOMOD_BLOCK: 143, AUTOMOD_ALERT: 144,
  STAGE_INVITE_SPEAKER: 300, STAGE_SUPPRESS_SPEAKER: 301, VOICE_MOVE: 302, VOICE_DISCONNECT: 303, VOICE_MODERATE: 304,
  VOICE_RECORDING_START: 305, VOICE_RECORDING_STOP: 306,
  SOUNDBOARD_SOUND_CREATE: 150, SOUNDBOARD_SOUND_UPDATE: 151, SOUNDBOARD_SOUND_DELETE: 152,
  RAID_DETECTED: 160, SAFETY_UPDATE: 161, ONBOARDING_UPDATE: 162, CHANNEL_FOLLOW_CREATE: 170, CHANNEL_FOLLOW_DELETE: 171, TEMPLATE_CREATE: 180, TEMPLATE_UPDATE: 181, TEMPLATE_DELETE: 182, WIDGET_UPDATE: 183,
  AUTOMOD_TEST: 146, MEMBER_WARN: 190, BAN_APPEAL_CREATE: 195, BAN_APPEAL_APPROVE: 196, BAN_APPEAL_DENY: 197, MEMBER_WARN_DELETE: 191, MEMBER_BULK_BAN: 192, MEMBER_BULK_KICK: 193, MOD_NOTE_UPDATE: 194, LINKED_ROLE_CREATE: 200, LINKED_ROLE_UPDATE: 201, LINKED_ROLE_DELETE: 202, BOOST_UPDATE: 203,
  POLL_END: 310, APPLICATION_UPDATE: 311, APPLICATION_TOKEN_RESET: 312, FORUM_TAG_UPDATE: 313,
} as const;
export type AuditAction = keyof typeof AuditActionType;

// ---------- applications / bots / OAuth2 ----------
export const OAuthScopes = ['bot', 'applications.commands', 'identify'] as const;
export type OAuthScope = (typeof OAuthScopes)[number];
export interface Application {
  id: Id; ownerId: Id; name: string; description: string; icon: string | null; botUser: User; botPublic: boolean; redirectUris: string[];
  /** Hex Ed25519 public key; Jorcord signs HTTP interaction deliveries and bots verify with this key. */
  publicKey: string; interactionsEndpointUrl: string | null; createdAt: string;
  /** App Directory listing settings (additive). */
  directory?: { listed: boolean; category: string; summary: string; tags: string[]; permissions: string };
  /** Privileged gateway intents the owner enabled (bitfield of Intents.GUILD_MEMBERS | GUILD_PRESENCES | MESSAGE_CONTENT). */ privilegedIntents?: number;
  /** Only present in the create response and in the bot token reset response: the one time the bot token / client secret is shown. */
  token?: string; clientSecret?: string;
}
export interface OAuthAuthorizePreview { application: Pick<Application, 'id' | 'name' | 'description' | 'icon' | 'botUser'>; scopes: OAuthScope[]; permissions: string; guilds: { id: Id; name: string; icon: string | null; /** permission bits the approver holds there, i.e. the most they may give the bot */ grantable: string }[] }
export interface OAuthAuthorizeResult { guildId?: Id; code?: string; redirectUri?: string; state?: string }

// ---------- application commands ----------
export const CommandType = { CHAT_INPUT: 1, USER: 2, MESSAGE: 3 } as const;
export const CommandOptionType = { SUB_COMMAND: 1, SUB_COMMAND_GROUP: 2, STRING: 3, INTEGER: 4, BOOLEAN: 5, USER: 6, CHANNEL: 7, ROLE: 8, MENTIONABLE: 9, NUMBER: 10, ATTACHMENT: 11 } as const;
export interface CommandOptionChoice { name: string; value: string | number }
export interface CommandOption {
  type: number; name: string; description: string; required?: boolean; choices?: CommandOptionChoice[]; options?: CommandOption[];
  channelTypes?: string[]; minValue?: number; maxValue?: number; minLength?: number; maxLength?: number; autocomplete?: boolean;
}
export interface ApplicationCommand {
  id: Id; applicationId: Id; guildId: Id | null; type: number; name: string; description: string; options: CommandOption[];
  /** Permission bitfield string; null = everyone. */ defaultMemberPermissions: string | null; dmPermission: boolean; nsfw: boolean; version: Id;
}
export interface CommandPermissionOverwrite { id: Id; type: 1 | 2 | 3; permission: boolean } // 1 role, 2 user, 3 channel

// ---------- interactions ----------
export const InteractionType = { PING: 1, APPLICATION_COMMAND: 2, MESSAGE_COMPONENT: 3, APPLICATION_COMMAND_AUTOCOMPLETE: 4, MODAL_SUBMIT: 5 } as const;
export const InteractionCallbackType = { PONG: 1, CHANNEL_MESSAGE_WITH_SOURCE: 4, DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5, DEFERRED_UPDATE_MESSAGE: 6, UPDATE_MESSAGE: 7, APPLICATION_COMMAND_AUTOCOMPLETE_RESULT: 8, MODAL: 9 } as const;
export const INTERACTION_TOKEN_TTL_MS = 15 * 60_000;
export const INTERACTION_ACK_DEADLINE_MS = 3000;
export const MessageFlags = { CROSSPOSTED: 1 << 0, IS_CROSSPOST: 1 << 1, SUPPRESS_EMBEDS: 1 << 2, EPHEMERAL: 1 << 6, LOADING: 1 << 7, SUPPRESS_NOTIFICATIONS: 1 << 12 } as const;
export interface InteractionOptionValue { name: string; type: number; value?: string | number | boolean; options?: InteractionOptionValue[]; focused?: boolean }
export interface Interaction {
  id: Id; applicationId: Id; type: number; token: string; version: 1; guildId: Id | null; channelId: Id | null; user: User; member?: unknown;
  appPermissions: string; locale: string;
  data?: {
    id?: Id; name?: string; type?: number; options?: InteractionOptionValue[]; targetId?: Id;
    customId?: string; componentType?: number; values?: string[]; components?: ModalSubmitRow[];
  };
  message?: unknown;
}
export interface ModalSubmitRow { type: 1; components: { type: 4; customId: string; value: string }[] }

// ---------- message components ----------
export const ComponentType = { ACTION_ROW: 1, BUTTON: 2, STRING_SELECT: 3, TEXT_INPUT: 4, USER_SELECT: 5, ROLE_SELECT: 6, MENTIONABLE_SELECT: 7, CHANNEL_SELECT: 8 } as const;
export const ButtonStyle = { PRIMARY: 1, SECONDARY: 2, SUCCESS: 3, DANGER: 4, LINK: 5 } as const;
export interface SelectOption { label: string; value: string; description?: string; emoji?: string; default?: boolean }
export interface Component {
  type: number; customId?: string; style?: number; label?: string; emoji?: string; url?: string; disabled?: boolean;
  options?: SelectOption[]; placeholder?: string; minValues?: number; maxValues?: number; channelTypes?: string[];
  // text input (modals only)
  textStyle?: 1 | 2; minLength?: number; maxLength?: number; required?: boolean; value?: string;
  components?: Component[];
}
export interface Modal { customId: string; title: string; components: Component[] }

// ---------- polls ----------
export interface PollAnswer { id: number; text: string; emoji?: string | null; count: number; meVoted: boolean }
export interface Poll { question: string; answers: PollAnswer[]; allowMultiselect: boolean; layoutType: 1; expiry: string; isFinalized: boolean; totalVotes: number }
export interface CreatePoll { question: string; answers: { text: string; emoji?: string | null }[]; durationHours?: number; allowMultiselect?: boolean }

// ---------- scheduled events ----------
export const ScheduledEventStatus = { SCHEDULED: 1, ACTIVE: 2, COMPLETED: 3, CANCELED: 4 } as const;
export const ScheduledEventEntityType = { STAGE_INSTANCE: 1, VOICE: 2, EXTERNAL: 3 } as const;
export type RecurrenceFrequency = 'daily' | 'weekly' | 'monthly';
export interface RecurrenceRule {
  frequency: RecurrenceFrequency;
  interval: number; // 1-12
  until?: string; // ISO datetime
  count?: number; // 1-52
}
export interface ScheduledEvent {
  id: Id; guildId: Id; channelId: Id | null; creatorId: Id; name: string; description: string | null; scheduledStartTime: string; scheduledEndTime: string | null;
  privacyLevel: 2; status: number; entityType: number; location: string | null; image: string | null; userCount: number; interested?: boolean;
  recurrenceRule?: RecurrenceRule | null; nextOccurrences?: string[];
}

// ---------- stage instances ----------
export interface StageInstance { id: Id; guildId: Id; channelId: Id; topic: string; privacyLevel: 2; scheduledEventId: Id | null; createdAt: string }

// ---------- forum tags / thread lifecycle ----------
export interface ForumTag { id: Id; name: string; emoji: string | null; moderated: boolean }
export const AUTO_ARCHIVE_DURATIONS = [60, 1440, 4320, 10080] as const;

/** One app installed in a server, as listed under Server Settings > Bots & Apps. */
export interface GuildIntegration {
  applicationId: Id; name: string; description: string; icon: string | null; botUserId: Id;
  /** a built-in Jorcord bot */ official: boolean; scopes: string[];
  /** the bot's managed role (null when only slash commands were installed) */ roleId: Id | null;
  /** permission bits of that role */ permissions: string; installedBy: Id; installedAt: string;
}
