import { z } from 'zod';
import { ButtonStyle, ComponentType, type Component, type Modal } from '@jorcord/shared';
import { ApiError } from '../errors';

const customId = z.string().min(1).max(100);
const httpUrl = z.string().max(512).refine((s) => { try { const u = new URL(s); return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password; } catch { return false; } }, 'url must be an absolute http(s) URL');
const emoji = z.string().min(1).max(64);
const selectOption = z.object({ label: z.string().min(1).max(100), value: z.string().min(1).max(100), description: z.string().max(100).optional(), emoji: emoji.optional(), default: z.boolean().optional() }).strict();

const button = z.object({ type: z.literal(ComponentType.BUTTON), style: z.number().int().min(1).max(5), label: z.string().min(1).max(80).optional(), emoji: emoji.optional(), customId: customId.optional(), url: httpUrl.optional(), disabled: z.boolean().optional() }).strict();
const stringSelect = z.object({
  type: z.literal(ComponentType.STRING_SELECT), customId, options: z.array(selectOption).min(1).max(25), placeholder: z.string().max(150).optional(),
  minValues: z.number().int().min(0).max(25).optional(), maxValues: z.number().int().min(1).max(25).optional(), disabled: z.boolean().optional(),
}).strict();
const entitySelect = z.object({
  type: z.union([z.literal(ComponentType.USER_SELECT), z.literal(ComponentType.ROLE_SELECT), z.literal(ComponentType.MENTIONABLE_SELECT), z.literal(ComponentType.CHANNEL_SELECT)]), customId,
  placeholder: z.string().max(150).optional(), minValues: z.number().int().min(0).max(25).optional(), maxValues: z.number().int().min(1).max(25).optional(),
  channelTypes: z.array(z.string().max(20)).max(10).optional(), disabled: z.boolean().optional(),
}).strict();
const textInput = z.object({
  type: z.literal(ComponentType.TEXT_INPUT), customId, label: z.string().min(1).max(45), textStyle: z.union([z.literal(1), z.literal(2)]).optional(),
  minLength: z.number().int().min(0).max(4000).optional(), maxLength: z.number().int().min(1).max(4000).optional(), required: z.boolean().optional(),
  value: z.string().max(4000).optional(), placeholder: z.string().max(100).optional(),
}).strict();
const row = z.object({ type: z.literal(ComponentType.ACTION_ROW), components: z.array(z.union([button, stringSelect, entitySelect, textInput])).min(1).max(5) }).strict();

const fail = (message: string, details?: unknown) => new ApiError(400, 'INVALID_COMPONENTS', message, details).num(50035);
const SELECT_TYPES: number[] = [ComponentType.STRING_SELECT, ComponentType.USER_SELECT, ComponentType.ROLE_SELECT, ComponentType.MENTIONABLE_SELECT, ComponentType.CHANNEL_SELECT];

function checkRow(r: z.infer<typeof row>, idx: number, modal: boolean) {
  const kinds = r.components.map((c) => c.type);
  const here = `components[${idx}]`;
  if (modal) {
    if (r.components.length !== 1 || kinds[0] !== ComponentType.TEXT_INPUT) throw fail(`${here}: a modal row holds exactly one text input`);
  } else {
    if (kinds.includes(ComponentType.TEXT_INPUT)) throw fail(`${here}: text inputs are only allowed in modals`);
    const selects = kinds.filter((k) => SELECT_TYPES.includes(k)).length;
    if (selects > 0 && r.components.length !== 1) throw fail(`${here}: a select menu must be alone in its row`);
    if (selects === 0 && r.components.length > 5) throw fail(`${here}: at most 5 buttons per row`);
  }
  r.components.forEach((c, j) => {
    const at = `${here}.components[${j}]`;
    if (c.type === ComponentType.BUTTON) {
      if (!c.label && !c.emoji) throw fail(`${at}: a button needs a label or emoji`);
      if (c.style === ButtonStyle.LINK) { if (!c.url || c.customId) throw fail(`${at}: link buttons need url and no customId`); }
      else if (!c.customId || c.url) throw fail(`${at}: non-link buttons need customId and no url`);
    } else if (SELECT_TYPES.includes(c.type)) {
      const sel = c as { minValues?: number; maxValues?: number; options?: unknown[] };
      const min = sel.minValues ?? 1, max = sel.maxValues ?? 1;
      if (min > max) throw fail(`${at}: minValues exceeds maxValues`);
      if (sel.options && max > sel.options.length) throw fail(`${at}: maxValues exceeds the number of options`);
      if (sel.options) { const vals = sel.options.map((o: any) => o.value); if (new Set(vals).size !== vals.length) throw fail(`${at}: duplicate option values`); }
    } else if (c.type === ComponentType.TEXT_INPUT) {
      if ((c.minLength ?? 0) > (c.maxLength ?? 4000)) throw fail(`${at}: minLength exceeds maxLength`);
    }
  });
}

/** Validates and normalises message components (max 5 action rows, unique customIds). Throws 400 INVALID_COMPONENTS. */
export function parseComponents(raw: unknown): Component[] {
  const arr = z.array(row).max(5).safeParse(raw ?? []);
  if (!arr.success) throw fail('Invalid components', arr.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  arr.data.forEach((r, i) => checkRow(r, i, false));
  const ids = arr.data.flatMap((r) => r.components.map((c) => (c as { customId?: string }).customId).filter(Boolean) as string[]);
  if (new Set(ids).size !== ids.length) throw fail('customId values must be unique within a message');
  return arr.data as unknown as Component[];
}

export function parseModal(raw: unknown): Modal {
  const p = z.object({ customId, title: z.string().min(1).max(45), components: z.array(row).min(1).max(5) }).strict().safeParse(raw);
  if (!p.success) throw fail('Invalid modal', p.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  p.data.components.forEach((r, i) => checkRow(r, i, true));
  const ids = p.data.components.map((r) => (r.components[0] as { customId: string }).customId);
  if (new Set(ids).size !== ids.length) throw fail('text input customId values must be unique');
  return p.data as unknown as Modal;
}

export function findComponent(components: Component[], id: string): Component | null {
  for (const r of components) for (const c of r.components ?? []) if (c.customId === id) return c;
  return null;
}
