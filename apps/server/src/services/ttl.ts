/** Deadline for a message about to be stored in `channel` (null = it stays). Only ordinary messages expire, never system notices. */
export function expiryFor(channel: { message_ttl_seconds?: number | null }, type: string): Date | null {
  const s = channel.message_ttl_seconds ?? 0;
  return s > 0 && (type === 'default' || type === 'reply') ? new Date(Date.now() + s * 1000) : null;
}
