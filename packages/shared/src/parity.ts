/** Parity pass: soundboard, activities, cosmetics, safety, onboarding... (additive types shared by server and clients). */
import type { Id } from './types';

// ---------- soundboard ----------
export interface SoundboardSound { id: Id; guildId: Id; name: string; emoji: string | null; /** 0..1 playback gain */ volume: number; url: string; creatorId: Id; createdAt: string }
