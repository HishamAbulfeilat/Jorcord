const EPOCH = 1735689600000n; // 2025-01-01
let seq = 0n, last = -1n;
const worker = BigInt(Math.floor(Math.random() * 1024));
/** Time-sortable 64-bit ID as decimal string. */
export function snowflake(now = Date.now()): string {
  let ts = BigInt(now) - EPOCH;
  if (ts === last) { seq = (seq + 1n) & 4095n; if (seq === 0n) ts = ++last; } else { seq = 0n; last = ts; }
  return ((ts << 22n) | (worker << 12n) | seq).toString();
}
export const snowflakeTime = (id: string) => Number((BigInt(id) >> 22n) + EPOCH);
