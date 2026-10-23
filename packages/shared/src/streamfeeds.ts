// ---------- OAuth-verified connections + stream/upload feeds ----------
/** Providers that can verify a profile connection with "Connect with ..." (server needs the client id/secret; see docs/INTEGRATIONS.md). */
export const OAUTH_CONNECTION_PROVIDERS = ['twitch', 'youtube'] as const;
export type OAuthConnectionProvider = (typeof OAUTH_CONNECTION_PROVIDERS)[number];
export const isOAuthConnectionProvider = (id: string): id is OAuthConnectionProvider => (OAUTH_CONNECTION_PROVIDERS as readonly string[]).includes(id);
export interface ConnectionProviderInfo { id: string; name: string; example: string; /** the server can verify this provider through OAuth */ oauth?: boolean }
export interface ConnectionOAuthStart { url: string; expiresIn: number }

export const STREAM_FEED_PROVIDERS = ['twitch', 'youtube'] as const;
export type StreamFeedProvider = (typeof STREAM_FEED_PROVIDERS)[number];
export const MAX_STREAM_FEEDS = 25;
export const MAX_STREAM_FEED_TEMPLATE = 300;
export const DEFAULT_STREAM_FEED_TEMPLATES: Record<StreamFeedProvider, string> = {
  twitch: '{channel} is live on Twitch: {title}\n{url}',
  youtube: '{channel} has a new video: {title}\n{url}',
};
export interface StreamFeed {
  id: string; guildId: string; provider: StreamFeedProvider;
  /** Twitch login or YouTube channel id (UC...) */
  externalId: string; /** display name of the watched channel */ name: string; /** public page of the watched channel */ url: string;
  channelId: string; template: string; roleId: string | null; enabled: boolean;
  lastAnnouncedAt: string | null; /** last provider error (cleared on success) */ lastError: string | null; createdBy: string; createdAt: string;
}
export interface StreamFeedsResponse { feeds: StreamFeed[]; /** which providers this server can poll (Twitch needs API credentials) */ providers: Record<StreamFeedProvider, boolean>; max: number }
