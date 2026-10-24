/**
 * Host side of the Embedded App SDK protocol (the page side is packages/activities-sdk).
 *
 * The host never trusts the frame: a message counts only when it comes from the iframe's own window AND from the origin the
 * app registered. Requests are answered with a RESPONSE carrying the request id; events are pushed to subscribed frames only.
 * Everything handed to the app is a copy of public, already-visible data (no tokens, no email).
 */
import { ACTIVITY_PROTOCOL, ACTIVITY_STATE_MAX_BYTES, activityOrigin, type ActivityInstance, type ActivityParticipant, type ActivitySubscription, type ChannelActivity } from '@jorcord/shared';

export interface ActivityViewer { id: string; username: string; displayName: string | null; avatar: string | null }

export interface HostDeps {
  /** origin the app registered; messages from any other origin are dropped */ activityOrigin: string;
  /** the iframe's contentWindow, resolved lazily */ frameWindow(): unknown;
  /** deliver a message to the frame (targetOrigin is always the registered origin) */ post(message: unknown, targetOrigin: string): void;
  getActivity(): ChannelActivity | undefined;
  getParticipants(): ActivityParticipant[];
  getViewer(): ActivityViewer | null;
  setState(state: unknown): Promise<ChannelActivity>;
  close(): void;
}

export const toInstance = (a: ChannelActivity): ActivityInstance => ({ id: a.id, applicationId: a.applicationId ?? '', channelId: a.channelId, guildId: a.guildId, hostId: a.hostId, state: a.state, startedAt: a.startedAt });

interface Envelope { source: string; v: number; type: string; id?: number; payload?: unknown }
const isEnvelope = (d: unknown): d is Envelope => !!d && typeof d === 'object' && (d as Envelope).source === ACTIVITY_PROTOCOL.source && (d as Envelope).v === ACTIVITY_PROTOCOL.version && typeof (d as Envelope).type === 'string';

/** URL to load in the frame: the registered URL plus launch context. Null when the stored URL is not an acceptable https URL. */
export function activityFrameUrl(rawUrl: string | null | undefined, ctx: { hostOrigin: string; activity: Pick<ChannelActivity, 'id' | 'channelId' | 'guildId' | 'applicationId'> }): string | null {
  if (!rawUrl || !activityOrigin(rawUrl)) return null;
  const u = new URL(rawUrl);
  u.searchParams.set('jorcord_host', ctx.hostOrigin);
  u.searchParams.set('instance_id', ctx.activity.id);
  u.searchParams.set('channel_id', ctx.activity.channelId);
  if (ctx.activity.guildId) u.searchParams.set('guild_id', ctx.activity.guildId);
  if (ctx.activity.applicationId) u.searchParams.set('application_id', ctx.activity.applicationId);
  return u.toString();
}

export function createActivityHost(deps: HostDeps) {
  const subs = new Set<ActivitySubscription>();
  const send = (m: Record<string, unknown>) => deps.post({ source: ACTIVITY_PROTOCOL.source, v: ACTIVITY_PROTOCOL.version, ...m }, deps.activityOrigin);
  const ok = (id: number | undefined, payload?: unknown) => { if (typeof id === 'number') send({ type: 'RESPONSE', id, ok: true, payload }); };
  const fail = (id: number | undefined, error: string, code: string) => { if (typeof id === 'number') send({ type: 'RESPONSE', id, ok: false, error, code }); };
  const ready = () => {
    const a = deps.getActivity(), viewer = deps.getViewer();
    if (!a || !viewer) return null;
    return { instance: toInstance(a), user: viewer, participants: deps.getParticipants() };
  };

  async function onMessage(e: { data: unknown; origin: string; source: unknown }): Promise<void> {
    if (e.source == null || e.source !== deps.frameWindow() || e.origin !== deps.activityOrigin) return; // wrong window or origin: ignore silently
    if (!isEnvelope(e.data)) return;
    const m = e.data;
    if (!(ACTIVITY_PROTOCOL.requests as readonly string[]).includes(m.type)) { fail(m.id, `Unknown request ${m.type.slice(0, 40)}`, 'UNKNOWN_REQUEST'); return; }
    switch (m.type) {
      case 'READY': { const r = ready(); if (r) ok(m.id, r); else fail(m.id, 'Activity is not running', 'NOT_RUNNING'); return; }
      case 'GET_INSTANCE': { const a = deps.getActivity(); if (a) ok(m.id, toInstance(a)); else fail(m.id, 'Activity is not running', 'NOT_RUNNING'); return; }
      case 'GET_PARTICIPANTS': ok(m.id, deps.getParticipants()); return;
      case 'GET_USER': { const v = deps.getViewer(); if (v) ok(m.id, v); else fail(m.id, 'Not signed in', 'NO_USER'); return; }
      case 'SUBSCRIBE': case 'UNSUBSCRIBE': {
        const ev = (m.payload as { event?: unknown } | undefined)?.event;
        if (typeof ev !== 'string' || !(ACTIVITY_PROTOCOL.subscriptions as readonly string[]).includes(ev)) { fail(m.id, 'Unknown event', 'BAD_EVENT'); return; }
        if (m.type === 'SUBSCRIBE') subs.add(ev as ActivitySubscription); else subs.delete(ev as ActivitySubscription);
        ok(m.id); return;
      }
      case 'SET_STATE': {
        const state = (m.payload as { state?: unknown } | undefined)?.state;
        let size = 0; try { size = new Blob([JSON.stringify(state ?? null)]).size; } catch { fail(m.id, 'State must be JSON', 'BAD_STATE'); return; }
        if (size > ACTIVITY_STATE_MAX_BYTES) { fail(m.id, `State is limited to ${ACTIVITY_STATE_MAX_BYTES} bytes`, 'STATE_TOO_LARGE'); return; }
        try { ok(m.id, toInstance(await deps.setState(state ?? {}))); } catch (err) { fail(m.id, (err as Error).message || 'Could not save the state', 'SET_STATE_FAILED'); }
        return;
      }
      case 'CLOSE': ok(m.id); deps.close(); return;
    }
  }

  /** Push an event to the frame when it subscribed to it. */
  function emit(event: ActivitySubscription, payload: unknown) {
    if (subs.has(event)) send({ type: 'EVENT', event, payload });
  }
  return { onMessage, emit, subscriptions: subs };
}
