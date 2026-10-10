/** Parity pass: soundboard, activities, cosmetics, safety, onboarding... (additive types shared by server and clients). */
import type { Id } from './types';

// ---------- soundboard ----------
export interface SoundboardSound { id: Id; guildId: Id; name: string; emoji: string | null; /** 0..1 playback gain */ volume: number; url: string; creatorId: Id; createdAt: string }

// ---------- rich presence / activities ----------
export type ActivityType = 'playing' | 'streaming' | 'listening' | 'watching' | 'competing';
/** What someone is doing right now. Set by the user's own client, or by a bot for itself; shown in the member list, friends list and profile. */
export interface Activity {
  type: ActivityType; name: string; details?: string | null; state?: string | null;
  /** streaming: link to the stream (http/https) */ url?: string | null;
  /** ISO time the activity began (the server fills it in when omitted) */ startedAt: string;
  applicationId?: Id | null; largeImage?: string | null; smallImage?: string | null;
}
export const MAX_ACTIVITIES = 5;
