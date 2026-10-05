import type { Tx } from '../config/prisma';

/**
 * Increment a named sequence (invoice numbers, purchase references) inside the caller's transaction.
 * The upsert locks the counter row until the transaction commits, so concurrent callers get
 * consecutive values and a rolled-back transaction gives its number back.
 */
export async function nextCounterValue(tx: Tx, key: string): Promise<number> {
  await tx.$executeRaw`INSERT INTO counters (\`key\`, value) VALUES (${key}, 1) ON DUPLICATE KEY UPDATE value = value + 1`;
  const rows = await tx.$queryRaw<{ value: number }[]>`SELECT value FROM counters WHERE \`key\` = ${key} FOR UPDATE`;
  return Number(rows[0].value);
}
