/** Sending interactions (slash commands, component presses, modal submits) and reacting to the gateway answers. */
import { snowflake } from '@jorcord/shared';
import type { ApplicationCommand, Component, Id, Message, Modal, ModalSubmitRow } from '@jorcord/shared';
import { api } from './api';
import { usePlatform } from '@/stores/platform';
import { useMessages } from '@/stores/messages';
import { useData, findChannel } from '@/stores/data';
import { useUI, toast, toastError } from '@/stores/ui';
import { buildInteractionOptions, type OptionValues, type Variant } from './commands';

/** The local-only "ephemeral" message the client shows when an app did not answer in 3 seconds (the server sends INTERACTION_FAILED). */
export function localNotice(channelId: Id, text: string, authorId?: Id | null): Message {
  const d = useData.getState(); const ch = findChannel(d, channelId);
  const author = (authorId && d.users[authorId]) || d.me!;
  return {
    id: snowflake(), channelId, guildId: ch?.guildId ?? null, author, content: text, createdAt: new Date().toISOString(), editedAt: null, type: 'default', replyTo: null,
    mentions: [], mentionRoles: [], mentionEveryone: false, attachments: [], embeds: [], reactions: [], pinned: false, stickerIds: [], threadId: null, flags: 64, components: [], poll: null, interaction: null, applicationId: authorId ?? null,
  } as Message;
}

export async function runCommand(channelId: Id, cmd: ApplicationCommand, variant: Variant, values: OptionValues): Promise<Id | null> {
  try {
    const r = await api.interactions.send({ type: 2, channelId, data: { id: cmd.id, options: buildInteractionOptions(variant, values) } });
    usePlatform.getState().track({ id: r.id, channelId, kind: 'command', name: cmd.name, applicationId: cmd.applicationId, at: Date.now() });
    return r.id;
  } catch (e) { toastError(e); return null; }
}

/** Presses a button / picks select values. `componentKey` is `messageId:customId` for the busy spinner. */
export async function pressComponent(m: Pick<Message, 'id' | 'channelId' | 'applicationId'>, c: Pick<Component, 'customId'>, values?: string[]): Promise<void> {
  if (!c.customId) return;
  try {
    const r = await api.interactions.send({ type: 3, channelId: m.channelId, messageId: m.id, data: { customId: c.customId, ...(values ? { values } : {}) } });
    usePlatform.getState().track({ id: r.id, channelId: m.channelId, kind: 'component', applicationId: m.applicationId ?? undefined, at: Date.now(), messageId: m.id, customId: c.customId });
  } catch (e) { toastError(e); }
}

export async function submitModal(channelId: Id, interactionId: Id, modal: Modal, values: Record<string, string>): Promise<boolean> {
  const rows: ModalSubmitRow[] = modal.components.flatMap((row) => (row.components ?? [row]).filter((c) => c.type === 4 && c.customId)).map((c) => ({ type: 1 as const, components: [{ type: 4 as const, customId: c.customId!, value: values[c.customId!] ?? '' }] }));
  try {
    const r = await api.interactions.send({ type: 5, channelId, interactionId, data: { customId: modal.customId, components: rows } });
    usePlatform.getState().track({ id: r.id, channelId, kind: 'modal', at: Date.now() });
    return true;
  } catch (e) { toastError(e); return false; }
}

/** Gateway: the app did not acknowledge in time. */
export function onInteractionFailed(d: { id: Id; applicationId: Id; channelId: Id | null }) {
  const p = usePlatform.getState().settle(d.id);
  const channelId = d.channelId ?? p?.channelId; if (!channelId) { toast('This interaction failed', 'error'); return; }
  if (p?.kind === 'component' || p?.kind === 'modal') toast('This interaction failed', 'error');
  else useMessages.getState().upsert(localNotice(channelId, 'The application did not respond', usePlatform.getState().apps[d.applicationId]?.botUserId));
}

/** Gateway: the app opened a modal. */
export function onInteractionModal(d: { interactionId: Id; applicationId: Id; modal: Modal }) {
  const p = usePlatform.getState().settle(d.interactionId);
  const channelId = p?.channelId ?? ((window as unknown as { __jorcordChannel?: string }).__jorcordChannel ?? '');
  useUI.getState().openModal({ kind: 'interactionModal', interactionId: d.interactionId, channelId, modal: d.modal });
}

export function onAutocompleteResult(d: { interactionId: Id; choices: { name: string; value: string | number }[] }) {
  usePlatform.getState().settle(d.interactionId);
  usePlatform.getState().setAutocomplete(d.interactionId, d.choices);
}

/** Any message from the app settles the oldest matching in-flight interaction (so button spinners stop). */
export function settleForMessage(m: Pick<Message, 'channelId' | 'applicationId' | 'interaction'>) {
  const st = usePlatform.getState();
  if (m.interaction?.id && st.interactions[m.interaction.id]) { st.settle(m.interaction.id); return; }
  if (!m.applicationId) return;
  const hit = Object.values(st.interactions).filter((i) => i.channelId === m.channelId && (!i.applicationId || i.applicationId === m.applicationId)).sort((a, b) => a.at - b.at)[0];
  if (hit) st.settle(hit.id);
}
