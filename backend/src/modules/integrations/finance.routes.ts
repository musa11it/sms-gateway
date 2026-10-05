import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { authenticateIntegrationKey, requireIntegrationScope } from '../../middlewares/integrationAuth';
import { integrationLimiter } from '../../middlewares/rateLimit';
import { actorFromRequest, metaFromRequest, type Actor } from '../../types/actor';
import { AppError } from '../../utils/errors';
import { asyncHandler, ok, paginated, paginationSchema, parse, toSkipTake, uuidParam } from '../../utils/http';
import { openFile } from '../../utils/storage';
import { audit } from '../audit-logs/audit.service';
import { getSetting } from '../settings/settings.service';
import * as verification from '../verification/verification.service';

/**
 * API for the separate finance system. It sees only verifications that are waiting for review
 * (never decided ones), only business and document data (no personal account details), and can
 * review individual documents — the final approve/reject of the business stays with platform staff.
 * Every call is audited against the credential that made it.
 */
export const financeIntegrationRouter = Router();
financeIntegrationRouter.use(authenticateIntegrationKey, integrationLimiter);

const OPEN = ['SUBMITTED', 'UNDER_REVIEW'] as const;
const DOCUMENT_FIELDS = { id: true, documentType: true, originalName: true, value: true, mimeType: true, sizeBytes: true, status: true, reviewNote: true, createdAt: true, reviewedAt: true } as const;
const ORGANIZATION_FIELDS = { id: true, name: true, businessType: true, country: true, city: true, address: true, registrationNumber: true, taxId: true, website: true } as const;

/** The credential acts as an API-key style actor; the integration name is recorded in each audit entry. */
const actorOf = (req: Parameters<typeof actorFromRequest>[0]): Actor => ({ type: 'API_KEY', apiKeyId: req.integration!.id });

const record = (req: Parameters<typeof actorFromRequest>[0], action: string, resourceId: string | null, organizationId: string | null, metadata: Record<string, unknown> = {}) =>
  audit({ actor: actorOf(req), action, resource: 'verification_document', resourceId, organizationId, metadata: { integration: req.integration!.name, ...metadata }, meta: metaFromRequest(req) });

financeIntegrationRouter.get(
  '/verifications',
  requireIntegrationScope('verification.view'),
  asyncHandler(async (req, res) => {
    const q = parse(paginationSchema.extend({ status: z.enum(OPEN).optional() }), req.query);
    const where: Prisma.VerificationWhereInput = { status: q.status ?? { in: [...OPEN] } };
    const [items, total] = await Promise.all([
      prisma.verification.findMany({
        where,
        orderBy: { submittedAt: 'asc' },
        ...toSkipTake(q),
        select: { id: true, status: true, submittedAt: true, organization: { select: ORGANIZATION_FIELDS }, _count: { select: { documents: true } } },
      }),
      prisma.verification.count({ where }),
    ]);
    return paginated(res, items, q.page, q.limit, total);
  }),
);

financeIntegrationRouter.get(
  '/verifications/:id',
  requireIntegrationScope('verification.view'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const v = await prisma.verification.findFirst({
      where: { id, status: { in: [...OPEN] } },
      select: { id: true, status: true, submittedAt: true, organization: { select: ORGANIZATION_FIELDS }, documents: { orderBy: { createdAt: 'desc' }, select: DOCUMENT_FIELDS } },
    });
    if (!v) throw AppError.notFound('Verification');
    await record(req, 'INTEGRATION_VERIFICATION_VIEWED', v.id, v.organization.id);
    return ok(res, { ...v, requirements: await getSetting('verification.requiredDocuments') });
  }),
);

async function openDocument(id: string) {
  const doc = await prisma.verificationDocument.findFirst({ where: { id, verification: { status: { in: [...OPEN] } } } });
  if (!doc) throw AppError.notFound('Document');
  return doc;
}

financeIntegrationRouter.get(
  '/documents/:id/download',
  requireIntegrationScope('verification.view'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const doc = await openDocument(id);
    if (!doc.storageKey || !doc.mimeType) throw AppError.notFound('Document');
    await record(req, 'INTEGRATION_DOCUMENT_VIEWED', id, doc.organizationId);
    res.setHeader('Content-Type', doc.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${doc.originalName.replace(/"/g, '')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    openFile(doc.storageKey).on('error', () => res.status(404).end()).pipe(res);
  }),
);

financeIntegrationRouter.post(
  '/documents/:id/review',
  requireIntegrationScope('verification.review'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ decision: z.enum(['APPROVED', 'REJECTED', 'REPLACEMENT_REQUESTED']), note: z.string().trim().max(1000).optional() }), req.body);
    const doc = await openDocument(id);
    const updated = await verification.reviewDocument(id, body.decision, body.note, actorOf(req), metaFromRequest(req));
    await record(req, 'INTEGRATION_DOCUMENT_REVIEWED', id, doc.organizationId, { decision: body.decision, previous: doc.status });
    return ok(res, { id: updated.id, status: updated.status, reviewNote: updated.reviewNote, reviewedAt: updated.reviewedAt }, 'Document reviewed');
  }),
);
