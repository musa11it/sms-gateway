import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { requireVerifiedEmail } from '../../middlewares/auth';
import { requireOrgPermission } from '../../middlewares/rbac';
import { uploadLimiter } from '../../middlewares/rateLimit';
import { documentUpload } from '../../middlewares/upload';
import { actorFromRequest, metaFromRequest } from '../../types/actor';
import { AppError } from '../../utils/errors';
import { asyncHandler, created, ok, parse, uuidParam } from '../../utils/http';
import { openFile } from '../../utils/storage';
import * as svc from './verification.service';

export const verificationRouter = Router();

verificationRouter.get(
  '/',
  requireOrgPermission('verification.view'),
  asyncHandler(async (req, res) => ok(res, await svc.getVerificationOverview(req.org!.id))),
);

verificationRouter.post(
  '/documents',
  uploadLimiter,
  requireVerifiedEmail,
  requireOrgPermission('verification.submit'),
  documentUpload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw AppError.badRequest('Attach the document in the "file" field', 'FILE_REQUIRED');
    const { documentType } = parse(z.object({ documentType: z.string().trim().min(1).max(64) }), req.body);
    const doc = await svc.uploadDocument(req.org!.id, req.file, documentType, actorFromRequest(req), metaFromRequest(req));
    return created(res, doc, 'Document uploaded');
  }),
);

verificationRouter.get(
  '/documents/:id/download',
  requireOrgPermission('verification.view'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const doc = await prisma.verificationDocument.findFirst({ where: { id, organizationId: req.org!.id } });
    if (!doc) throw AppError.notFound('Document');
    res.setHeader('Content-Type', doc.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${doc.originalName.replace(/"/g, '')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    openFile(doc.storageKey).on('error', () => res.status(404).end()).pipe(res);
  }),
);

verificationRouter.delete(
  '/documents/:id',
  requireOrgPermission('verification.submit'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    await svc.deleteDocument(req.org!.id, id, actorFromRequest(req), metaFromRequest(req));
    return ok(res, null, 'Document removed');
  }),
);

verificationRouter.post(
  '/submit',
  requireVerifiedEmail,
  requireOrgPermission('verification.submit'),
  asyncHandler(async (req, res) => {
    await svc.submitVerification(req.org!.id, actorFromRequest(req), metaFromRequest(req));
    return ok(res, await svc.getVerificationOverview(req.org!.id), 'Verification submitted. Our team will review it shortly.');
  }),
);
