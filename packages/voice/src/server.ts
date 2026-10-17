/** Optional server-side helpers (Node). Requires `livekit-server-sdk`. The app server owns /voice/token; these are building blocks. */
import { AccessToken, RoomServiceClient, TrackSource, type VideoGrant } from 'livekit-server-sdk';

export interface GrantInput { room: string; canPublish: boolean; canSubscribe?: boolean; stage?: boolean; hidden?: boolean }

export function buildVideoGrant(g: GrantInput): VideoGrant {
  return {
    room: g.room, roomJoin: true,
    canPublish: g.canPublish, canSubscribe: g.canSubscribe ?? true,
    // required for hand-raise / priority attributes
    canUpdateOwnMetadata: true,
    canPublishData: true,
    canPublishSources: g.canPublish ? [TrackSource.MICROPHONE, TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO] : [],
    hidden: g.hidden,
  };
}

export async function mintToken(o: { apiKey: string; apiSecret: string; identity: string; name?: string; metadata?: string; ttl?: string } & GrantInput): Promise<string> {
  const at = new AccessToken(o.apiKey, o.apiSecret, { identity: o.identity, name: o.name, metadata: o.metadata, ttl: o.ttl ?? '6h' });
  at.addGrant(buildVideoGrant(o));
  return at.toJwt();
}

/** Stage: promote an audience member to speaker (moderator action). */
export async function promoteToSpeaker(svc: RoomServiceClient, room: string, identity: string) {
  await svc.updateParticipant(room, identity, undefined, {
    canPublish: true, canSubscribe: true, canPublishData: true, canUpdateMetadata: true,
    canPublishSources: [TrackSource.MICROPHONE],
  } as any);
}
export async function demoteToAudience(svc: RoomServiceClient, room: string, identity: string) {
  await svc.updateParticipant(room, identity, undefined, { canPublish: false, canSubscribe: true, canPublishData: true, canUpdateMetadata: true } as any);
}
