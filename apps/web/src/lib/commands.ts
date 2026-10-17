/** Pure helpers behind the slash-command picker: filtering, sub-command flattening, option validation and the `POST /interactions` payload. */
import { CommandOptionType as OT } from '@jorcord/shared';
import type { ApplicationCommand, CommandOption, InteractionOptionValue } from '@jorcord/shared';

export type OptionValues = Record<string, string | number | boolean | undefined>;

/** `"/ping foo"` -> `{ name: 'ping', rest: 'foo' }`; null when the text is not a slash command. */
export function parseSlash(text: string): { name: string; rest: string; hasSpace: boolean } | null {
  const m = /^\/([\w-]{0,32})(\s([\s\S]*))?$/.exec(text);
  return m ? { name: m[1]!.toLowerCase(), rest: m[3] ?? '', hasSpace: m[2] !== undefined } : null;
}

/** Name-prefix matches first, then substring matches; chat-input commands only (user/message commands live in context menus). Stable for equal ranks. */
export function filterCommands(cmds: ApplicationCommand[], q: string, limit = 12): ApplicationCommand[] {
  const s = q.trim().toLowerCase();
  const chat = cmds.filter((c) => c.type === 1);
  if (!s) return chat.slice(0, limit);
  const rank = (c: ApplicationCommand) => (c.name === s ? 0 : c.name.startsWith(s) ? 1 : c.name.includes(s) ? 2 : -1);
  return chat.map((c, i) => ({ c, r: rank(c), i })).filter((x) => x.r >= 0).sort((a, b) => a.r - b.r || a.i - b.i).slice(0, limit).map((x) => x.c);
}

export interface Variant { path: string[]; label: string; description: string; options: CommandOption[] }
const isSub = (o: CommandOption) => o.type === OT.SUB_COMMAND || o.type === OT.SUB_COMMAND_GROUP;

/** A command with sub-commands/groups becomes one variant per leaf ("group sub"); a plain command is a single variant with no path. */
export function variantsOf(cmd: Pick<ApplicationCommand, 'options' | 'description'>): Variant[] {
  const opts = cmd.options ?? [];
  if (!opts.some(isSub)) return [{ path: [], label: '', description: cmd.description, options: opts }];
  const out: Variant[] = [];
  const walk = (list: CommandOption[], path: string[]) => {
    for (const o of list) {
      if (o.type === OT.SUB_COMMAND) out.push({ path: [...path, o.name], label: [...path, o.name].join(' '), description: o.description, options: o.options ?? [] });
      else if (o.type === OT.SUB_COMMAND_GROUP) walk(o.options ?? [], [...path, o.name]);
    }
  };
  walk(opts, []);
  return out;
}

/** Wire representation of the chosen variant: nested `{type:2 group → type:1 sub → leaf options}` exactly like Discord's interaction data. */
export function buildInteractionOptions(v: Variant, values: OptionValues): InteractionOptionValue[] {
  const leaves: InteractionOptionValue[] = [];
  for (const o of v.options) {
    const raw = values[o.name];
    if (raw === undefined || raw === '') continue;
    leaves.push({ name: o.name, type: o.type, value: coerceValue(o, raw) });
  }
  let nested: InteractionOptionValue[] = leaves;
  for (let i = v.path.length - 1; i >= 0; i--) {
    const isLeaf = i === v.path.length - 1;
    nested = [{ name: v.path[i]!, type: isLeaf ? OT.SUB_COMMAND : OT.SUB_COMMAND_GROUP, options: nested }];
  }
  return nested;
}

export function coerceValue(o: Pick<CommandOption, 'type'>, raw: string | number | boolean): string | number | boolean {
  if (o.type === OT.INTEGER) return Math.trunc(Number(raw));
  if (o.type === OT.NUMBER) return Number(raw);
  if (o.type === OT.BOOLEAN) return raw === true || raw === 'true';
  return String(raw);
}

/** Per-option error text; empty object = ready to run. Attachments cannot be sent from this client. */
export function validateOptions(options: CommandOption[], values: OptionValues): Record<string, string> {
  const errs: Record<string, string> = {};
  for (const o of options) {
    const raw = values[o.name];
    const empty = raw === undefined || raw === '';
    if (o.type === OT.ATTACHMENT) { if (o.required) errs[o.name] = 'Attachments cannot be sent from the web client yet'; continue; }
    if (empty) { if (o.required) errs[o.name] = 'This field is required'; continue; }
    if (o.type === OT.STRING) {
      const s = String(raw);
      if (o.minLength != null && s.length < o.minLength) errs[o.name] = `Must be at least ${o.minLength} characters`;
      else if (o.maxLength != null && s.length > o.maxLength) errs[o.name] = `Must be at most ${o.maxLength} characters`;
    } else if (o.type === OT.INTEGER || o.type === OT.NUMBER) {
      const n = Number(raw);
      if (!Number.isFinite(n)) errs[o.name] = 'Enter a number';
      else if (o.type === OT.INTEGER && !Number.isInteger(n)) errs[o.name] = 'Enter a whole number';
      else if (o.minValue != null && n < o.minValue) errs[o.name] = `Must be at least ${o.minValue}`;
      else if (o.maxValue != null && n > o.maxValue) errs[o.name] = `Must be at most ${o.maxValue}`;
    }
  }
  return errs;
}

/** Options for the in-flight autocomplete request: everything typed so far, the focused one flagged. */
export function autocompleteOptions(v: Variant, values: OptionValues, focused: string): InteractionOptionValue[] {
  const leaves = buildInteractionOptions({ ...v, path: [] }, values).filter((o) => o.name !== focused);
  const f = v.options.find((o) => o.name === focused);
  if (f) leaves.push({ name: f.name, type: f.type, value: String(values[focused] ?? ''), focused: true });
  let nested = leaves;
  for (let i = v.path.length - 1; i >= 0; i--) nested = [{ name: v.path[i]!, type: i === v.path.length - 1 ? OT.SUB_COMMAND : OT.SUB_COMMAND_GROUP, options: nested }];
  return nested;
}

/** The command's display line: "/group sub" */
export const commandLabel = (c: Pick<ApplicationCommand, 'name'>, v?: Variant) => `/${c.name}${v?.label ? ' ' + v.label : ''}`;
