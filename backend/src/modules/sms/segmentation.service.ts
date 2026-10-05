import type { SmsSegmentationConfig } from '@prisma/client';
import { z } from 'zod';
import { prisma, type Db } from '../../config/prisma';
import type { Actor, RequestMeta } from '../../types/actor';
import { actorUserId } from '../../types/actor';
import { AppError } from '../../utils/errors';
import { calculateSegments } from '../../utils/segmentation';
import { audit } from '../audit-logs/audit.service';
import { getSetting } from '../settings/settings.service';

/**
 * The single source of truth for SMS segmentation. Every price/credit calculation (dashboard,
 * campaigns, public API, wallet debit, provider capacity) goes through analyzeMessage().
 *
 * Rules are versioned and append-only: saving creates a new version, the highest version is
 * active, and each message stores the version it was billed with, so history never changes.
 */

/** Hard safety limits (also enforced by a CHECK constraint): an SMS part physically carries at most 160 septets / 70 UCS-2 units. */
export const SEGMENTATION_LIMITS = {
  gsm7SingleSegment: { min: 10, max: 160 },
  gsm7MultiSegment: { min: 10, max: 153 },
  ucs2SingleSegment: { min: 10, max: 70 },
  ucs2MultiSegment: { min: 10, max: 67 },
  maxMessageCharacters: { min: 10, max: 10_000 },
} as const;

/** Longest text any endpoint accepts before the configured limit is checked (request-size guard). */
export const MESSAGE_INPUT_HARD_LIMIT = 20_000;

/** Bootstrap only: used to create version 1 if the table is empty (fresh or wiped database). */
const INITIAL_RULES = { gsm7SingleSegment: 160, gsm7MultiSegment: 153, ucs2SingleSegment: 70, ucs2MultiSegment: 67, maxMessageCharacters: 1600 };

const int = (k: keyof typeof SEGMENTATION_LIMITS) =>
  z.coerce
    .number({ invalid_type_error: 'Enter a whole number' })
    .int('Enter a whole number')
    .min(SEGMENTATION_LIMITS[k].min, `Must be at least ${SEGMENTATION_LIMITS[k].min}`)
    .max(SEGMENTATION_LIMITS[k].max, `Must be at most ${SEGMENTATION_LIMITS[k].max.toLocaleString()}`);

export const segmentationConfigBody = z
  .object({
    gsm7SingleSegment: int('gsm7SingleSegment'),
    gsm7MultiSegment: int('gsm7MultiSegment'),
    ucs2SingleSegment: int('ucs2SingleSegment'),
    ucs2MultiSegment: int('ucs2MultiSegment'),
    maxMessageCharacters: int('maxMessageCharacters'),
    reason: z.string().trim().min(5, 'Explain the change (at least 5 characters)').max(500),
  })
  .strict()
  .refine((c) => c.gsm7MultiSegment <= c.gsm7SingleSegment, { message: 'The multipart limit cannot exceed the single-segment limit', path: ['gsm7MultiSegment'] })
  .refine((c) => c.ucs2MultiSegment <= c.ucs2SingleSegment, { message: 'The multipart limit cannot exceed the single-segment limit', path: ['ucs2MultiSegment'] });

export function serializeConfig(c: SmsSegmentationConfig) {
  return {
    version: c.version,
    gsm7: { singleSegment: c.gsm7SingleSegment, multiSegment: c.gsm7MultiSegment },
    ucs2: { singleSegment: c.ucs2SingleSegment, multiSegment: c.ucs2MultiSegment },
    maxMessageCharacters: c.maxMessageCharacters,
    reason: c.reason,
    createdById: c.createdById,
    createdAt: c.createdAt,
  };
}

/** The active (highest) version; creates version 1 on an empty database. Always read fresh, so changes apply immediately. */
export async function getActiveSegmentationConfig(db: Db = prisma): Promise<SmsSegmentationConfig> {
  const active = await db.smsSegmentationConfig.findFirst({ orderBy: { version: 'desc' } });
  if (active) return active;
  await db.smsSegmentationConfig.createMany({ data: [{ version: 1, ...INITIAL_RULES, reason: 'Initial configuration' }], skipDuplicates: true });
  return db.smsSegmentationConfig.findFirstOrThrow({ orderBy: { version: 'desc' } });
}

/**
 * Measure a message with the active rules: encoding, characters, segments and credits per recipient.
 * `tooLong` is reported rather than thrown so previews can show it; senders call assertSendable().
 */
export async function analyzeMessage(message: string, db: Db = prisma) {
  const [config, perSegment] = await Promise.all([getActiveSegmentationConfig(db), getSetting('sms.creditsPerSegment')]);
  const seg = calculateSegments(message, config);
  return {
    ...seg,
    creditsPerRecipient: seg.segments * perSegment,
    maxMessageCharacters: config.maxMessageCharacters,
    tooLong: seg.characterCount > config.maxMessageCharacters,
    segmentationVersion: config.version,
  };
}

export type MessageAnalysis = Awaited<ReturnType<typeof analyzeMessage>>;

/** Rejects empty, too-long or over-segmented messages using the active configuration and settings. */
export async function assertSendable(a: MessageAnalysis) {
  if (a.characterCount === 0) throw AppError.unprocessable('Message cannot be empty', 'EMPTY_MESSAGE', [{ field: 'message', message: 'Required' }]);
  if (a.tooLong) {
    throw AppError.unprocessable(`Message is too long (${a.characterCount.toLocaleString()} characters; maximum ${a.maxMessageCharacters.toLocaleString()})`, 'MESSAGE_TOO_LONG', [
      { field: 'message', message: `Maximum ${a.maxMessageCharacters.toLocaleString()} characters` },
    ]);
  }
  const maxSegments = await getSetting('sms.maxMessageSegments');
  if (a.segments > maxSegments) {
    throw AppError.unprocessable(`Message is too long (${a.segments} segments; maximum ${maxSegments})`, 'MESSAGE_TOO_LONG', [{ field: 'message', message: 'Too long' }]);
  }
}

/** Save a new version. Affects messages accepted from now on; stored messages keep their version. */
export async function updateSegmentationConfig(input: z.infer<typeof segmentationConfigBody>, actor: Actor, meta?: RequestMeta) {
  const { reason, ...rules } = input;
  const created = await prisma.$transaction(async (tx) => {
    const current = await getActiveSegmentationConfig(tx);
    // Lock the newest row so concurrent saves get consecutive versions (the PK rejects any race).
    await tx.$queryRaw`SELECT version FROM sms_segmentation_configs WHERE version = ${current.version} FOR UPDATE`;
    const unchanged = (Object.keys(rules) as (keyof typeof rules)[]).every((k) => rules[k] === current[k]);
    if (unchanged) throw AppError.conflict('These values are already the active configuration', 'SEGMENTATION_UNCHANGED');
    const next = await tx.smsSegmentationConfig.create({ data: { version: current.version + 1, ...rules, reason, createdById: actorUserId(actor) } });
    const changes = Object.fromEntries(
      (Object.keys(rules) as (keyof typeof rules)[]).filter((k) => rules[k] !== current[k]).map((k) => [k, { from: current[k], to: rules[k] }]),
    );
    await audit(
      {
        actor,
        action: 'SMS_SEGMENTATION_CONFIG_UPDATED',
        resource: 'sms_segmentation_config',
        resourceId: String(next.version),
        metadata: { configType: 'SMS_SEGMENTATION', fromVersion: current.version, toVersion: next.version, changes, reason },
        meta,
      },
      tx,
    );
    return next;
  });
  return created;
}

export async function segmentationOverview() {
  const versions = await prisma.smsSegmentationConfig.findMany({ orderBy: { version: 'desc' }, take: 50 });
  const active = versions[0] ?? (await getActiveSegmentationConfig());
  const users = await prisma.user.findMany({ where: { id: { in: versions.map((v) => v.createdById).filter((x): x is string => !!x) } }, select: { id: true, fullName: true } });
  const named = (c: SmsSegmentationConfig) => ({ ...serializeConfig(c), createdBy: users.find((u) => u.id === c.createdById)?.fullName ?? null });
  return {
    active: named(active),
    versions: (versions.length ? versions : [active]).map(named),
    limits: SEGMENTATION_LIMITS,
    creditsPerSegment: await getSetting('sms.creditsPerSegment'),
    maxMessageSegments: await getSetting('sms.maxMessageSegments'),
  };
}

/** Preview shape returned by the estimate endpoints (informational: sends always recalculate). */
export function serializeEstimate(a: MessageAnalysis) {
  return {
    encoding: a.encoding,
    characterCount: a.characterCount,
    units: a.units,
    segmentCount: a.segments,
    creditsPerRecipient: a.creditsPerRecipient,
    charactersPerSingleSegment: a.charactersPerSingleSegment,
    charactersPerMultipartSegment: a.charactersPerMultipartSegment,
    remainingInSegment: a.remainingInSegment,
    maxMessageCharacters: a.maxMessageCharacters,
    tooLong: a.tooLong,
    segmentationVersion: a.segmentationVersion,
  };
}
