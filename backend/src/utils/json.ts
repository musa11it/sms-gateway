import type { Prisma } from '@prisma/client';

/**
 * Read a JSON column that holds a list of strings (MySQL has no scalar lists,
 * so columns such as tags, scopes and routePrefixes are stored as JSON arrays).
 */
export function stringList(value: Prisma.JsonValue | null | undefined): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
