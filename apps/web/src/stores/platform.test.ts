import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, ScheduledEvent, StageInstance } from '@jorcord/shared';

vi.mock('@/lib/api', () => ({ api: { interactions: { send: vi.fn() } } }));
import { api } from '@/lib/api';
import { usePlatform } from './platform';
import { isEphemeral, useMessages } from './messages';
import { useData } from './data';
import { useUI } from './ui';
import { localNotice, onAutocompleteResult, onInteractionFailed, onInteractionModal, pressComponent, runCommand, settleForMessage, submitModal } from '@/lib/interactions';

const user = (id: string, bot = false) => ({ id, username: id, displayName: id, avatar: null, banner: null, accentColor: null, bio: null, pronouns: null, bot, createdAt: '' });
const msg = (id: string, o: Partial<Message> = {}): Message => ({ id, channelId: 'ch', guildId: 'g', author: user('u1'), content: 'hi', createdAt: new Date().toISOString(), editedAt: null, type: 'default', replyTo: null, mentions: [], mentionRoles: [], mentionEveryone: false, attachments: [], embeds: [], reactions: [], pinned: false, stickerIds: [], threadId: null, ...o });
const ev = (id: string, status = 1, o: Partial<ScheduledEvent> = {}): ScheduledEvent => ({ id, guildId: 'g', channelId: null, creatorId: 'u', name: id, description: null, scheduledStartTime: '2026-10-12T10:00:00Z', scheduledEndTime: null, privacyLevel: 2, status, entityType: 3, location: 'x', image: null, userCount: 0, ...o });

beforeEach(() => { usePlatform.getState().reset(); useMessages.setState({ ch: {}, pending: [] }); useData.setState({ me: user('me') as never, users: { me: user('me'), bot1: user('bot1', true) } }); useUI.setState({ modal: null, toasts: [] }); vi.mocked(api.interactions.send).mockReset(); });

describe('scheduled events store', () => {
  it('upserts upcoming events and drops completed/canceled ones', () => {
    const p = usePlatform.getState();
    p.setEvents('g', [ev('a'), ev('b')]); expect(Object.keys(usePlatform.getState().events.g!)).toEqual(['a', 'b']);
    p.upsertEvent(ev('a', 2, { name: 'renamed' })); expect(usePlatform.getState().events.g!.a).toMatchObject({ status: 2, name: 'renamed' });
    p.upsertEvent(ev('a', 3)); expect(usePlatform.getState().events.g!.a).toBeUndefined();
    p.removeEvent({ id: 'b', guildId: 'g' }); expect(usePlatform.getState().events.g).toEqual({});
  });
  it('an update without my flag keeps what we knew', () => {
    const p = usePlatform.getState(); p.setEvents('g', [ev('a', 1, { interested: true })]); p.upsertEvent(ev('a', 1, { name: 'x' }));
    expect(usePlatform.getState().events.g!.a!.interested).toBe(true);
  });
  it('my own interest is applied once even when the optimistic toggle and the gateway echo both arrive', () => {
    const p = usePlatform.getState(); p.setEvents('g', [ev('a', 1, { userCount: 4 })]);
    p.eventInterest('g', 'a', 1, true); p.eventInterest('g', 'a', 1, true);
    expect(usePlatform.getState().events.g!.a).toMatchObject({ userCount: 5, interested: true });
    p.eventInterest('g', 'a', 1, false); expect(usePlatform.getState().events.g!.a!.userCount).toBe(6); // someone else
    p.eventInterest('g', 'a', -1, true); p.eventInterest('g', 'a', -1, true);
    expect(usePlatform.getState().events.g!.a).toMatchObject({ userCount: 5, interested: false });
  });
});

describe('stage store', () => {
  const st = (c: string, topic: string): StageInstance => ({ id: 's' + c, guildId: 'g', channelId: c, topic, privacyLevel: 2, scheduledEventId: null, createdAt: '' });
  it('tracks topics per channel and clears ended stages', () => {
    const p = usePlatform.getState(); p.setStage(st('c1', 'AMA')); p.setStage(st('c1', 'AMA 2')); expect(usePlatform.getState().stages.c1!.topic).toBe('AMA 2');
    p.removeStage('c1'); expect(usePlatform.getState().stages.c1).toBeUndefined();
  });
  it('setStages replaces the listed channels so a stage that ended elsewhere disappears', () => {
    const p = usePlatform.getState(); p.setStage(st('old', 'x')); p.setStages('g', [st('c2', 'y')], ['old', 'c2']);
    expect(Object.keys(usePlatform.getState().stages)).toEqual(['c2']); expect(usePlatform.getState().stagesLoaded.g).toBe(true);
  });
});

describe('poll votes and ephemerals in the message store', () => {
  const poll = (): Message['poll'] => ({ question: 'q', answers: [{ id: 1, text: 'a', count: 1, meVoted: false }, { id: 2, text: 'b', count: 0, meVoted: false }], allowMultiselect: false, layoutType: 1, expiry: new Date(Date.now() + 1e6).toISOString(), isFinalized: false, totalVotes: 1 });
  it('MESSAGE_POLL_VOTE_ADD/REMOVE move the counts', () => {
    useMessages.getState().init('ch', [msg('1', { poll: poll() })], 50);
    useMessages.getState().pollVote('ch', '1', 2, 1, true); useMessages.getState().pollVote('ch', '1', 1, -1, false);
    expect(useMessages.getState().ch.ch!.list[0]!.poll).toMatchObject({ totalVotes: 1, answers: [{ count: 0, meVoted: false }, { count: 1, meVoted: true }] }); // 1 distinct voter before, the exact total follows from the re-read
  });
  it('a broadcast MESSAGE_UPDATE finalizing the poll keeps my vote marks; replace() trusts the response', () => {
    useMessages.getState().init('ch', [msg('1', { poll: { ...poll()!, answers: [{ id: 1, text: 'a', count: 1, meVoted: true }, { id: 2, text: 'b', count: 0, meVoted: false }] } })], 50);
    useMessages.getState().update(msg('1', { poll: { ...poll()!, isFinalized: true } }));
    expect(useMessages.getState().ch.ch!.list[0]!.poll).toMatchObject({ isFinalized: true, answers: [{ meVoted: true }, { meVoted: false }] });
    useMessages.getState().replace(msg('1', { poll: { ...poll()!, answers: [{ id: 1, text: 'a', count: 0, meVoted: false }, { id: 2, text: 'b', count: 1, meVoted: true }] } }));
    expect(useMessages.getState().ch.ch!.list[0]!.poll!.answers.map((a) => a.meVoted)).toEqual([false, true]);
  });
  it('ephemeral replies survive a channel re-initialisation (they are never refetched)', () => {
    useMessages.getState().init('ch', [msg('1')], 50);
    useMessages.getState().upsert(msg('2', { flags: 64, content: 'only you' }));
    useMessages.getState().init('ch', [msg('1'), msg('3')], 50);
    expect(useMessages.getState().ch.ch!.list.map((m) => m.id)).toEqual(['1', '2', '3']); expect(isEphemeral(useMessages.getState().ch.ch!.list[1]!)).toBe(true);
    useMessages.getState().remove('ch', '2'); expect(useMessages.getState().ch.ch!.list.map((m) => m.id)).toEqual(['1', '3']);
  });
});

describe('interactions', () => {
  const cmd = { id: 'c1', applicationId: 'app1', guildId: null, type: 1, name: 'roll', description: '', options: [{ name: 'sides', type: 4, description: '' }], defaultMemberPermissions: null, dmPermission: true, nsfw: false, version: '1' };
  it('runCommand posts type 2 with nested option data and tracks the interaction', async () => {
    vi.mocked(api.interactions.send).mockResolvedValue({ id: 'i1' });
    const id = await runCommand('ch', cmd, { path: [], label: '', description: '', options: cmd.options }, { sides: '20' });
    expect(id).toBe('i1'); expect(api.interactions.send).toHaveBeenCalledWith({ type: 2, channelId: 'ch', data: { id: 'c1', options: [{ name: 'sides', type: 4, value: 20 }] } });
    expect(usePlatform.getState().interactions.i1).toMatchObject({ kind: 'command', channelId: 'ch', applicationId: 'app1', name: 'roll' });
  });
  it('pressComponent posts type 3 with customId (+ values) and marks the button busy until the app answers', async () => {
    vi.mocked(api.interactions.send).mockResolvedValue({ id: 'i2' });
    await pressComponent({ id: 'm1', channelId: 'ch', applicationId: 'app1' }, { customId: 'pick' }, ['a', 'b']);
    expect(api.interactions.send).toHaveBeenCalledWith({ type: 3, channelId: 'ch', messageId: 'm1', data: { customId: 'pick', values: ['a', 'b'] } });
    expect(usePlatform.getState().busy['m1:pick']).toBeTruthy();
    settleForMessage({ channelId: 'ch', applicationId: 'app1', interaction: null }); expect(usePlatform.getState().busy['m1:pick']).toBeUndefined();
  });
  it('a failed send surfaces a toast and tracks nothing', async () => {
    vi.mocked(api.interactions.send).mockRejectedValue(Object.assign(new Error('Unknown channel'), { status: 404 }));
    await pressComponent({ id: 'm1', channelId: 'ch' }, { customId: 'x' });
    expect(useUI.getState().toasts.at(-1)).toMatchObject({ kind: 'error', text: 'Unknown channel' }); expect(Object.keys(usePlatform.getState().interactions)).toEqual([]);
  });
  it('INTERACTION_MODAL opens the modal for the originating channel; submit posts type 5 with the typed values', async () => {
    usePlatform.getState().track({ id: 'i3', channelId: 'ch', kind: 'command', at: Date.now() });
    const modal = { customId: 'feedback', title: 'Feedback', components: [{ type: 1, components: [{ type: 4, customId: 'text', label: 'Text' }] }, { type: 1, components: [{ type: 4, customId: 'why', label: 'Why', textStyle: 2 as const }] }] };
    onInteractionModal({ interactionId: 'i3', applicationId: 'app1', modal });
    expect(useUI.getState().modal).toMatchObject({ kind: 'interactionModal', interactionId: 'i3', channelId: 'ch' });
    vi.mocked(api.interactions.send).mockResolvedValue({ id: 'i4' });
    expect(await submitModal('ch', 'i3', modal, { text: 'hello', why: 'because' })).toBe(true);
    expect(api.interactions.send).toHaveBeenCalledWith({ type: 5, channelId: 'ch', interactionId: 'i3', data: { customId: 'feedback', components: [{ type: 1, components: [{ type: 4, customId: 'text', value: 'hello' }] }, { type: 1, components: [{ type: 4, customId: 'why', value: 'because' }] }] } });
  });
  it('autocomplete results land in the store keyed by interaction id', () => {
    usePlatform.getState().track({ id: 'i5', channelId: 'ch', kind: 'autocomplete', at: 1 });
    onAutocompleteResult({ interactionId: 'i5', choices: [{ name: 'Alpha', value: 'a' }] });
    expect(usePlatform.getState().autocomplete.i5).toEqual([{ name: 'Alpha', value: 'a' }]); expect(usePlatform.getState().interactions.i5).toBeUndefined();
  });
  it('INTERACTION_FAILED on a command shows "The application did not respond" as an ephemeral notice from the bot', () => {
    usePlatform.getState().setApps([{ id: 'app1', name: 'Dicebot', icon: null, botUserId: 'bot1' }]);
    usePlatform.getState().track({ id: 'i6', channelId: 'ch', kind: 'command', at: 1, applicationId: 'app1' });
    onInteractionFailed({ id: 'i6', applicationId: 'app1', channelId: 'ch' });
    const m = useMessages.getState().ch.ch!.list[0]!; expect(m.content).toBe('The application did not respond'); expect(isEphemeral(m)).toBe(true); expect(m.author.id).toBe('bot1');
    expect(usePlatform.getState().interactions.i6).toBeUndefined();
  });
  it('INTERACTION_FAILED on a component press is a toast, not a message', () => {
    usePlatform.getState().track({ id: 'i7', channelId: 'ch', kind: 'component', at: 1, messageId: 'm', customId: 'b' });
    onInteractionFailed({ id: 'i7', applicationId: 'app1', channelId: 'ch' });
    expect(useUI.getState().toasts.at(-1)).toMatchObject({ text: 'This interaction failed', kind: 'error' }); expect(useMessages.getState().ch.ch).toBeUndefined(); expect(usePlatform.getState().busy['m:b']).toBeUndefined();
  });
  it('a reply from the app settles the matching in-flight interaction by id', () => {
    usePlatform.getState().track({ id: 'i8', channelId: 'ch', kind: 'command', at: 1, applicationId: 'app1' });
    settleForMessage({ channelId: 'ch', applicationId: 'app1', interaction: { id: 'i8', type: 2, name: 'roll', userId: 'me' } });
    expect(usePlatform.getState().interactions.i8).toBeUndefined();
  });
  it('localNotice builds a valid ephemeral Message', () => { const m = localNotice('ch', 'x', 'bot1'); expect(m.flags).toBe(64); expect(m.author.id).toBe('bot1'); expect(m.guildId).toBeNull(); });
});
