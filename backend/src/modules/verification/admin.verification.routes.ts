import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { requirePlatformPermission } from '../../middlewares/rbac';
import { actorFromRequest, metaFromRequest } from '../../types/actor';
import { AppError } from '../../utils/errors';
import { asyncHandler, ok, paginated, paginationSchema, parse, toSkipTake, uuidParam } from '../../utils/http';
import { openFile } from '../../utils/storage';
import { audit } from '../audit-logs/audit.service';
import { getSetting } from '../settings/settings.service';
import * as svc from './verification.service';

export const adminVerificationRouter = Router();

adminVerificationRouter.get(
  '/',
  requirePlatformPermission('verification.view'),
  asyncHandler(async (req, res) => {
    const q = parse(
      paginationSchema.extend({ status: z.enum(['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'MORE_INFORMATION_REQUIRED', 'SUSPENDED', 'APPROVED', 'REJECTED']).optional() }),
      req.query,
    );
    const where: Prisma.VerificationWhereInput = q.status ? { status: q.status } : { status: { in: ['SUBMITTED', 'UNDER_REVIEW'] } };
    const [items, total] = await Promise.all([
      prisma.verification.findMany({
        where,
        orderBy: { submittedAt: 'asc' },
        ...toSkipTake(q),
        include: { organization: { select: { id: true, name: true, businessType: true, country: true, status: true } }, _count: { select: { documents: true } } },
      }),
      prisma.verification.count({ where }),
    ]);
    return paginated(res, items, q.page, q.limit, total);
  }),
);

adminVerificationRouter.get(
  '/:id',
  requirePlatformPermission('verification.view'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const v = await prisma.verification.findUnique({
      where: { id },
      include: {
        organization: { include: { members: { where: { isOwner: true }, include: { user: { select: { id: true, fullName: true, email: true, phone: true, status: true, emailVerifiedAt: true } } } } } },
        documents: { orderBy: { createdAt: 'desc' }, select: { id: true, documentType: true, originalName: true, mimeType: true, sizeBytes: true, status: true, reviewNote: true, createdAt: true, reviewedAt: true } },
        reviews: { orderBy: { createdAt: 'desc' }, take: 50 },
      },
    });
    if (!v) throw AppError.notFound('Verification');
    const history = await prisma.auditLog.findMany({
      where: { organizationId: v.organizationId, resource: { in: ['verification', 'verification_document', 'organization'] } },
      orderBy: { createdAt: 'desc' },
      take: 30,
      include: { actor: { select: { fullName: true } } },
    });
    return ok(res, { ...v, requirements: await getSetting('verification.requiredDocuments'), history });
  }),
);

adminVerificationRouter.get(
  '/documents/:id/download',
  requirePlatformPermission('verification.view'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const doc = await prisma.verificationDocument.findUnique({ where: { id } });
    if (!doc) throw AppError.notFound('Document');
    await audit({ actor: actorFromRequest(req), action: 'DOCUMENT_VIEWED', resource: 'verification_document', resourceId: id, organizationId: doc.organizationId, meta: metaFromRequest(req) });
    res.setHeader('Content-Type', doc.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${doc.originalName.replace(/"/g, '')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    openFile(doc.storageKey).on('error', () => res.status(404).end()).pipe(res);
  }),
);

adminVerificationRouter.post(
  '/:id/start-review',
  requirePlatformPermission('verification.review'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    await svc.startReview(id, actorFromRequest(req), metaFromRequest(req));
    return ok(res, null, 'Review started');
  }),
);

adminVerificationRouter.post(
  '/documents/:id/review',
  requirePlatformPermission('verification.review'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ decision: z.enum(['APPROVED', 'REJECTED', 'REPLACEMENT_REQUESTED']), note: z.string().trim().max(1000).optional() }), req.body);
    return ok(res, await svc.reviewDocument(id, body.decision, body.note, actorFromRequest(req), metaFromRequest(req)), 'Document reviewed');
  }),
);

adminVerificationRouter.post(
  '/:id/decision',
  asyncHandler(async (req, res, next) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ decision: z.enum(['APPROVE', 'REJECT', 'REQUEST_INFORMATION']), note: z.string().trim().max(2000).optional() }), req.body);
    const needed = body.decision === 'APPROVE' ? 'verification.approve' : body.decision === 'REJECT' ? 'verification.reject' : 'verification.review';
    if (!req.user!.platformPermissions.has(needed)) return next(AppError.forbidden(undefined, 'PERMISSION_DENIED'));
    await svc.decideVerification(id, body.decision, body.note, actorFromRequest(req), metaFromRequest(req));
    return ok(res, null, body.decision === 'APPROVE' ? 'Organization approved' : body.decision === 'REJECT' ? 'Verification rejected' : 'More information requested');
  }),
);
