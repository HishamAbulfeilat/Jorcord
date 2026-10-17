import { z } from 'zod';
import { CommandOptionType as OT, CommandType, type CommandOption } from '@jorcord/shared';
import { ApiError } from '../errors';

const fail = (message: string, details?: unknown) => new ApiError(400, 'INVALID_COMMAND', message, details).num(50035);
const CHAT_NAME = /^[\p{L}\p{N}_-]{1,32}$/u;
const OTHER_NAME = /^[\p{L}\p{N}_ -]{1,32}$/u;

const choice = z.object({ name: z.string().min(1).max(100), value: z.union([z.string().max(100), z.number().finite()]) }).strict();
const optionSchema: z.ZodType<CommandOption> = z.lazy(() => z.object({
  type: z.number().int().min(1).max(11), name: z.string(), description: z.string().min(1).max(100), required: z.boolean().optional(),
  choices: z.array(choice).max(25).optional(), options: z.array(optionSchema).max(25).optional(), channelTypes: z.array(z.string().max(20)).max(10).optional(),
  minValue: z.number().finite().optional(), maxValue: z.number().finite().optional(), minLength: z.number().int().min(0).max(6000).optional(), maxLength: z.number().int().min(1).max(6000).optional(),
  autocomplete: z.boolean().optional(),
}).strict());

function checkOptions(opts: CommandOption[], depth: number, path: string) {
  const names = new Set<string>();
  const hasSub = opts.some((o) => o.type === OT.SUB_COMMAND || o.type === OT.SUB_COMMAND_GROUP);
  let seenOptional = false;
  for (const [i, o] of opts.entries()) {
    const at = `${path}[${i}]`;
    if (!CHAT_NAME.test(o.name) || o.name !== o.name.toLowerCase()) throw fail(`${at}.name must be 1-32 lowercase letters, digits, - or _`);
    if (names.has(o.name)) throw fail(`${at}.name is duplicated`);
    names.add(o.name);
    const isSub = o.type === OT.SUB_COMMAND || o.type === OT.SUB_COMMAND_GROUP;
    if (hasSub && !isSub) throw fail(`${at}: sub commands cannot be mixed with plain options`);
    if (isSub) {
      if (o.type === OT.SUB_COMMAND_GROUP && depth > 0) throw fail(`${at}: sub command groups are only allowed at the top level`);
      if (o.type === OT.SUB_COMMAND && depth > 1) throw fail(`${at}: sub commands nest at most two levels`);
      if (o.choices || o.autocomplete || o.required) throw fail(`${at}: sub commands take no choices/autocomplete/required`);
      const kids = o.options ?? [];
      if (o.type === OT.SUB_COMMAND_GROUP && (!kids.length || kids.some((k) => k.type !== OT.SUB_COMMAND))) throw fail(`${at}: a group contains only sub commands`);
      checkOptions(kids, depth + 1, `${at}.options`);
      continue;
    }
    if (o.options) throw fail(`${at}: only sub commands have nested options`);
    if (o.required) { if (seenOptional) throw fail(`${at}: required options must come before optional ones`); } else seenOptional = true;
    if (o.choices) {
      if (![OT.STRING, OT.INTEGER, OT.NUMBER].includes(o.type as any)) throw fail(`${at}: choices only apply to string/integer/number options`);
      if (o.autocomplete) throw fail(`${at}: autocomplete cannot be combined with choices`);
      for (const c of o.choices) {
        if (o.type === OT.STRING ? typeof c.value !== 'string' : typeof c.value !== 'number') throw fail(`${at}: choice value type must match the option type`);
        if (o.type === OT.INTEGER && !Number.isInteger(c.value)) throw fail(`${at}: integer choice must be an integer`);
      }
      if (new Set(o.choices.map((c) => c.name)).size !== o.choices.length) throw fail(`${at}: duplicate choice names`);
    }
    if (o.autocomplete && ![OT.STRING, OT.INTEGER, OT.NUMBER].includes(o.type as any)) throw fail(`${at}: autocomplete only applies to string/integer/number options`);
    if ((o.minValue !== undefined || o.maxValue !== undefined) && ![OT.INTEGER, OT.NUMBER].includes(o.type as any)) throw fail(`${at}: minValue/maxValue only apply to integer/number options`);
    if ((o.minLength !== undefined || o.maxLength !== undefined) && o.type !== OT.STRING) throw fail(`${at}: minLength/maxLength only apply to string options`);
    if (o.minValue !== undefined && o.maxValue !== undefined && o.minValue > o.maxValue) throw fail(`${at}: minValue exceeds maxValue`);
    if (o.channelTypes && o.type !== OT.CHANNEL) throw fail(`${at}: channelTypes only apply to channel options`);
  }
}

export interface ParsedCommand { type: number; name: string; description: string; options: CommandOption[]; defaultMemberPermissions: string | null; dmPermission: boolean; nsfw: boolean }
const body = z.object({
  type: z.number().int().min(1).max(3).optional(), name: z.string().min(1).max(32), description: z.string().max(100).optional(), options: z.array(optionSchema).max(25).optional(),
  defaultMemberPermissions: z.string().regex(/^\d{1,20}$/).nullable().optional(), dmPermission: z.boolean().optional(), nsfw: z.boolean().optional(),
}).strict();

export function parseCommand(raw: unknown): ParsedCommand {
  const p = body.safeParse(raw);
  if (!p.success) throw fail('Invalid command', p.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  const c = p.data, type = c.type ?? CommandType.CHAT_INPUT;
  if (type === CommandType.CHAT_INPUT) {
    if (!CHAT_NAME.test(c.name) || c.name !== c.name.toLowerCase()) throw fail('name must be 1-32 lowercase letters, digits, - or _');
    if (!c.description?.length) throw fail('Slash commands need a description (1-100 characters)');
  } else {
    if (!OTHER_NAME.test(c.name) || !c.name.trim()) throw fail('name must be 1-32 letters, digits, spaces, - or _');
    if (c.description) throw fail('User and message commands have no description');
    if (c.options?.length) throw fail('User and message commands take no options');
  }
  checkOptions(c.options ?? [], 0, 'options');
  if (JSON.stringify(c).length > 8000) throw fail('Command is too large (8000 characters)');
  return { type, name: c.name, description: c.description ?? '', options: c.options ?? [], defaultMemberPermissions: c.defaultMemberPermissions ?? null, dmPermission: c.dmPermission ?? true, nsfw: c.nsfw ?? false };
}

/** Per-scope limits (Discord's public numbers): 100 slash, 15 user, 15 message commands. */
export const COMMAND_LIMITS: Record<number, number> = { [CommandType.CHAT_INPUT]: 100, [CommandType.USER]: 15, [CommandType.MESSAGE]: 15 };
