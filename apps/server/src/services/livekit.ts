import { RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import type { Config } from '../config';

/**
 * Server-side control of LiveKit participants (RoomService). Every method is best-effort: the participant may not
 * have connected to LiveKit yet (they only hold a gateway voice state), which is not an error.
 */
export interface LiveKitControl {
  /** Apply what the participant is currently allowed to do. Revoking a permission also stops their live tracks. */
  setPermissions(room: string, identity: string, p: { canSpeak: boolean; canStream: boolean; canSubscribe: boolean }): Promise<void>;
  remove(room: string, identity: string): Promise<void>;
  /**
   * Set participant attributes from the server (e.g. `jv.priority`). Jorcord's tokens do not carry canUpdateOwnMetadata, so only
   * the server can write them: that is what makes priority speaker unspoofable for apps that read the attribute.
   */
  setAttributes(room: string, identity: string, attributes: Record<string, string>): Promise<void>;
  /** Stop `viewer` receiving the screen-share tracks of `publisher` (a kicked Go Live viewer). */
  unsubscribeScreen(room: string, viewer: string, publisher: string): Promise<void>;
}

export class NullLiveKitControl implements LiveKitControl {
  async setPermissions() { /* disabled */ }
  async remove() { /* disabled */ }
  async setAttributes() { /* disabled */ }
  async unsubscribeScreen() { /* disabled */ }
}

export class RoomServiceControl implements LiveKitControl {
  private client: RoomServiceClient;
  constructor(cfg: Config['livekit'], private log: { warn: (o: object, m: string) => void }) {
    this.client = new RoomServiceClient(cfg.apiUrl.replace(/^ws/, 'http'), cfg.apiKey, cfg.apiSecret);
  }
  private async safe(what: string, fn: () => Promise<unknown>) {
    try { await fn(); } catch (err: any) {
      if (err?.status === 404 || /not found|does not exist/i.test(String(err?.message))) return;
      this.log.warn({ err, what }, 'livekit control call failed');
    }
  }
  async setPermissions(room: string, identity: string, p: { canSpeak: boolean; canStream: boolean; canSubscribe: boolean }) {
    const sources = [...(p.canSpeak ? [TrackSource.MICROPHONE] : []), ...(p.canStream ? [TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO] : [])];
    await this.safe('updateParticipant', () => this.client.updateParticipant(room, identity, { permission: { canPublish: sources.length > 0, canPublishSources: sources, canSubscribe: p.canSubscribe, canPublishData: true } }));
    if (!p.canSpeak) {
      await this.safe('muteTracks', async () => {
        const info = await this.client.getParticipant(room, identity);
        for (const t of info.tracks) if (t.source === TrackSource.MICROPHONE && !t.muted) await this.client.mutePublishedTrack(room, identity, t.sid, true);
      });
    }
  }
  async remove(room: string, identity: string) { await this.safe('removeParticipant', () => this.client.removeParticipant(room, identity)); }
  async setAttributes(room: string, identity: string, attributes: Record<string, string>) {
    await this.safe('setAttributes', () => this.client.updateParticipant(room, identity, { attributes }));
  }
  async unsubscribeScreen(room: string, viewer: string, publisher: string) {
    await this.safe('unsubscribeScreen', async () => {
      const info = await this.client.getParticipant(room, publisher);
      const sids = info.tracks.filter((t) => t.source === TrackSource.SCREEN_SHARE || t.source === TrackSource.SCREEN_SHARE_AUDIO).map((t) => t.sid);
      if (sids.length) await this.client.updateSubscriptions(room, viewer, sids, false);
    });
  }
}

export function createLiveKitControl(cfg: Config, log: { warn: (o: object, m: string) => void }): LiveKitControl {
  return cfg.livekitControl ? new RoomServiceControl(cfg.livekit, log) : new NullLiveKitControl();
}
