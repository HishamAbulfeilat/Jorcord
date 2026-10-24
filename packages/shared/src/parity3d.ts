// Package D (developer platform): application emoji, user-installable apps, embedded activities.
import type { Id } from './types';

/** Where an app can be installed. Numbers match Discord's. */
export const IntegrationType = { GUILD_INSTALL: 0, USER_INSTALL: 1 } as const;
/** Where a command may be used. Numbers match Discord's. */
export const InteractionContextType = { GUILD: 0, BOT_DM: 1, PRIVATE_CHANNEL: 2 } as const;
export const MAX_APPLICATION_EMOJIS = 2000;
export const APPLICATION_EMOJI_MAX_BYTES = 256 * 1024;

export interface ApplicationEmoji { id: Id; applicationId: Id; name: string; animated: boolean; url: string }

/** Wire protocol between the Jorcord web client (host) and a third-party activity iframe. Mirrored in packages/activities-sdk. */
export const ACTIVITY_PROTOCOL = {
  /** envelope marker, so unrelated postMessage traffic is ignored */ source: 'jorcord-activity',
  version: 1,
  /** activity -> host */ requests: ['READY', 'GET_INSTANCE', 'GET_PARTICIPANTS', 'GET_USER', 'SUBSCRIBE', 'UNSUBSCRIBE', 'SET_STATE', 'CLOSE'] as const,
  /** host -> activity */ events: ['READY_ACK', 'RESPONSE', 'EVENT'] as const,
  /** events an activity may subscribe to */ subscriptions: ['VOICE_STATE_UPDATE', 'ACTIVITY_UPDATE', 'PARTICIPANTS_UPDATE'] as const,
} as const;
export type ActivityRequestType = (typeof ACTIVITY_PROTOCOL.requests)[number];
export type ActivitySubscription = (typeof ACTIVITY_PROTOCOL.subscriptions)[number];
export interface ActivityParticipant { id: Id; username: string; displayName: string | null; avatar: string | null; selfMute: boolean; selfDeaf: boolean }
export interface ActivityInstance { id: Id; applicationId: Id; channelId: Id; guildId: Id | null; hostId: Id; state: unknown; startedAt: string }

/** `sandbox` attribute of the activity iframe. Never add allow-top-navigation, allow-popups-to-escape-sandbox or allow-modals. */
export const ACTIVITY_SANDBOX = 'allow-scripts allow-same-origin allow-forms';
/** `allow` attribute: no powerful features are delegated except fullscreen. */
export const ACTIVITY_ALLOW = 'fullscreen';

/** Origin of an activity URL (https only, no credentials), or null when it is not acceptable. */
export function activityOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    return u.origin;
  } catch { return null; }
}
