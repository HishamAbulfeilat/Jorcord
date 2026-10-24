/**
 * Built-in text commands, expanded on the client before a message is sent (same behaviour as the classic chat commands):
 *   /me <text>        -> _text_                (action, italic)
 *   /shrug [text]     -> text ¯\_(ツ)_/¯
 *   /tableflip [text] -> text (╯°□°)╯︵ ┻━┻
 *   /unflip [text]    -> text ┬─┬ ノ( ゜-゜ノ)
 * Only when the whole message starts with the command word followed by a space or the end; "/shrugging" and "see /me" are left alone.
 * Slash commands registered by apps take priority in the picker; these are only used when the text is not one of those.
 */
export const TEXT_COMMANDS = ['me', 'shrug', 'tableflip', 'unflip'] as const;
export type TextCommand = (typeof TEXT_COMMANDS)[number];

/** Markdown-safe: the backslash and underscores are escaped so the face survives the markdown renderer. */
const FACES: Record<Exclude<TextCommand, 'me'>, string> = {
  shrug: '¯\\_(ツ)_/¯',
  tableflip: '(╯°□°)╯︵ ┻━┻',
  unflip: '┬─┬ ノ( ゜-゜ノ)',
};
const SHRUG_ESCAPED = '¯\\\\\\_(ツ)\\_/¯';

export function expandTextCommand(input: string): string {
  const m = /^\/(me|shrug|tableflip|unflip)(?:\s+([\s\S]*))?$/i.exec(input);
  if (!m) return input;
  const cmd = m[1]!.toLowerCase() as TextCommand, rest = (m[2] ?? '').trim();
  if (cmd === 'me') return rest ? `_${rest.replace(/_/g, '\\_')}_` : input; // "/me" alone is not an action: send it as typed
  const face = cmd === 'shrug' ? SHRUG_ESCAPED : FACES[cmd];
  return rest ? `${rest} ${face}` : face;
}

/** Picker hints (name + description) for the slash popup, kept beside the logic. */
export const TEXT_COMMAND_HELP: { name: TextCommand; description: string }[] = [
  { name: 'me', description: 'Show an action in italics' },
  { name: 'shrug', description: 'Append ¯\\_(ツ)_/¯ to your message' },
  { name: 'tableflip', description: 'Append (╯°□°)╯︵ ┻━┻ to your message' },
  { name: 'unflip', description: 'Append ┬─┬ ノ( ゜-゜ノ) to your message' },
];
