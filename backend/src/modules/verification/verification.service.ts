import { prisma } from '../../config/prisma';
import type { Actor, RequestMeta } from '../../types/actor';
import { actorUserId } from '../../types/actor';
import { AppError, type FieldError } from '../../utils/errors';
import { deleteFile, saveFile } from '../../utils/storage';
import { ALLOWED_DOCUMENT_TYPES, detectFileType } from '../../middlewares/upload';
import { audit } from '../audit-logs/audit.service';
import { notifyOrganization, notifyStaff } from '../notifications/notification.service';
import { getSetting } from '../settings/settings.service';

const EDITABLE = ['DRAFT', 'MORE_INFORMATION_REQUIRED', 'REJECTED'] as const;

export const REQUIRED_PROFILE_FIELDS = [
  ['name', 'Organization name'],
  ['businessType', 'Business type'],
  ['country', 'Country'],
  ['address', 'Address'],
  ['registrationNumber', 'Business registration number'],
  ['contactPersonName', 'Contact person'],
  ['contactPersonPhone', 'Contact phone'],
  ['smsPurpose', 'Purpose of SMS'],
] as const;

export async function getCurrentVerification(organizationId: string) {
  let v = await prisma.verification.findFirst({ where: { organizationId }, orderBy: { createdAt: 'desc' } });
  if (!v) v = await prisma.verification.create({ data: { organizationId, status: 'DRAFT' } });
  return v;
}

export async function getVerificationOverview(organizationId: string) {
  const [org, v, requirements, businessTypes] = await Promise.all([
    prisma.organization.findUniqueOrThrow({ where: { id: organizationId } }),
    getCurrentVerification(organizationId),
    getSetting('verification.requiredDocuments'),
    getSetting('verification.businessTypes'),
  ]);
  const documents = await prisma.verificationDocument.findMany({
    where: { verificationId: v.id },
    orderBy: { createdAt: 'desc' },
    select: { id: true, documentType: true, originalName: true, mimeType: true, sizeBytes: true, status: true, reviewNote: true, createdAt: true, reviewedAt: true },
  });
  const missingFields = REQUIRED_PROFILE_FIELDS.filter(([k]) => !org[k]).map(([k, label]) => ({ field: k, label }));
  const missingDocuments = requirements
    .filter((r) => r.required && !documents.some((d) => d.documentType === r.type && ['PENDING', 'APPROVED'].includes(d.status)))
    .map((r) => ({ type: r.type, label: r.label }));
  return {
    verification: v,
    documents,
    requirements,
    businessTypes,
    missingFields,
    missingDocuments,
    canEdit: (EDITABLE as readonly string[]).includes(v.status),
    canSubmit: (EDITABLE as readonly string[]).includes(v.status) && missingFields.length === 0 && missingDocuments.length === 0,
  };
}

export async function uploadDocument(
  organizationId: string,
  file: { buffer: Buffer; mimetype: string; originalname: string; size: number },
  documentType: string,
  actor: Actor,
  meta?: RequestMeta,
) {
  const requirements = await getSetting('verification.requiredDocuments');
  if (!requirements.some((r) => r.type === documentType)) {
    throw AppError.unprocessable('Unknown document type', 'INVALID_DOCUMENT_TYPE', [{ field: 'documentType', message: 'Unknown document type' }]);
  }
  const detected = detectFileType(file.buffer);
  if (!detected || detected !== file.mimetype) throw AppError.unprocessable('File content does not match its type (PDF, PNG or JPEG only)', 'INVALID_FILE_CONTENT');

  const v = await getCurrentVerification(organizationId);
  if (!(EDITABLE as readonly string[]).includes(v.status)) throw AppError.conflict('Verification is under review and cannot be changed', 'VERIFICATION_LOCKED');

  const stored = await saveFile(organizationId, file.buffer, ALLOWED_DOCUMENT_TYPES[detected]);
  const safeName = file.originalname.replace(/[^\w.\- ]/g, '_').slice(0, 150) || 'document';
  const doc = await prisma.verificationDocument.create({
    data: {
      organizationId,
      verificationId: v.id,
      documentType,
      originalName: safeName,
      mimeType: detected,
      sizeBytes: file.size,
      storageKey: stored.storageKey,
      checksum: stored.checksum,
      uploadedById: actorUserId(actor)!,
    },
    select: { id: true, documentType: true, originalName: true, mimeType: true, sizeBytes: true, status: true, createdAt: true },
  });
  await audit({ actor, action: 'DOCUMENT_UPLOADED', resource: 'verification_document', resourceId: doc.id, organizationId, metadata: { documentType, sizeBytes: file.size }, meta });
  return doc;
}

export async function deleteDocument(organizationId: string, id: string, actor: Actor, meta?: RequestMeta) {
  const doc = await prisma.verificationDocument.findFirst({ where: { id, organizationId }, include: { verification: true } });
  if (!doc) throw AppError.notFound('Document');
  if (!(EDITABLE as readonly string[]).includes(doc.verification.status) || doc.status === 'APPROVED') {
    throw AppError.conflict('This document can no longer be removed', 'VERIFICATION_LOCKED');
  }
  await prisma.verificationDocument.delete({ where: { id } });
  await deleteFile(doc.storageKey);
  await audit({ actor, action: 'DOCUMENT_DELETED', resource: 'verification_document', resourceId: id, organizationId, meta });
}

export async function submitVerification(organizationId: string, actor: Actor, meta?: RequestMeta) {
  const userId = actorUserId(actor)!;
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.emailVerifiedAt) throw AppError.forbidden('Verify your email address before submitting', 'EMAIL_NOT_VERIFIED');

  const overview = await getVerificationOverview(organizationId);
  if (!overview.canEdit) throw AppError.conflict('Verification has already been submitted', 'ALREADY_SUBMITTED');
  const errors: FieldError[] = [
    ...overview.missingFields.map((f) => ({ field: f.field, message: `${f.label} is required` })),
    ...overview.missingDocuments.map((d) => ({ field: `documents.${d.type}`, message: `${d.label} is required` })),
  ];
  if (errors.length) throw AppError.unprocessable('Please complete your profile and upload the required documents', 'VERIFICATION_INCOMPLETE', errors);

  const org = await prisma.$transaction(async (tx) => {
    await tx.verification.update({ where: { id: overview.verification.id }, data: { status: 'SUBMITTED', submittedAt: new Date(), submittedById: userId, reviewNote: null } });
    const org = await tx.organization.update({ where: { id: organizationId }, data: { status: 'PENDING_REVIEW', statusReason: null } });
    // Owner accounts that were rejected go back to review.
    await tx.user.updateMany({ where: { id: userId, status: { in: ['REJECTED', 'PENDING_REVIEW'] } }, data: { status: 'PENDING_REVIEW', statusReason: null } });
    await audit({ actor, action: 'VERIFICATION_SUBMITTED', resource: 'verification', resourceId: overview.verification.id, organizationId, meta }, tx);
    return org;
  });
  await notifyStaff('verification.review', { type: 'VERIFICATION_SUBMITTED', title: 'New verification to review', body: `${org.name} submitted business verification`, link: `/admin/verification/${overview.verification.id}` });
}

// ── Staff review ───────────────────────────────────────────────────────

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** Every review action is kept as an immutable history row (in addition to the audit log). */
async function recordReview(
  tx: Tx,
  v: { id: string; organizationId: string },
  action: string,
  fromStatus: string | null,
  toStatus: string | null,
  note: string | undefined | null,
  actor: Actor,
) {
  await tx.verificationReview.create({
    data: { verificationId: v.id, organizationId: v.organizationId, reviewerId: actorUserId(actor), action, fromStatus, toStatus, note: note ?? null },
  });
}

export async function startReview(id: string, actor: Actor, meta?: RequestMeta) {
  const v = await prisma.verification.findUnique({ where: { id } });
  if (!v) throw AppError.notFound('Verification');
  if (v.status !== 'SUBMITTED') throw AppError.conflict('Only submitted verifications can be taken into review', 'INVALID_TRANSITION');
  await prisma.$transaction(async (tx) => {
    await tx.verification.update({ where: { id }, data: { status: 'UNDER_REVIEW', reviewedById: actorUserId(actor) } });
    await recordReview(tx, v, 'START_REVIEW', v.status, 'UNDER_REVIEW', null, actor);
    await audit({ actor, action: 'VERIFICATION_REVIEW_STARTED', resource: 'verification', resourceId: id, organizationId: v.organizationId, meta }, tx);
  });
}

export async function reviewDocument(docId: string, decision: 'APPROVED' | 'REJECTED' | 'REPLACEMENT_REQUESTED', note: string | undefined, actor: Actor, meta?: RequestMeta) {
  const doc = await prisma.verificationDocument.findUnique({ where: { id: docId } });
  if (!doc) throw AppError.notFound('Document');
  if (decision !== 'APPROVED' && !note?.trim()) throw AppError.unprocessable('A note is required', 'NOTE_REQUIRED', [{ field: 'note', message: 'Required' }]);
  return prisma.$transaction(async (tx) => {
    const updated = await tx.verificationDocument.update({
      where: { id: docId },
      data: { status: decision, reviewNote: note ?? null, reviewedById: actorUserId(actor), reviewedAt: new Date() },
    });
    await recordReview(tx, { id: doc.verificationId, organizationId: doc.organizationId }, `DOCUMENT_${decision}`, doc.status, decision, note, actor);
    await audit({ actor, action: `DOCUMENT_${decision}`, resource: 'verification_document', resourceId: docId, organizationId: doc.organizationId, metadata: { note, documentType: doc.documentType }, meta }, tx);
    return updated;
  });
}

export type VerificationDecision = 'APPROVE' | 'REJECT' | 'REQUEST_INFORMATION';

export async function decideVerification(id: string, decision: VerificationDecision, note: string | undefined, actor: Actor, meta?: RequestMeta) {
  const v = await prisma.verification.findUnique({ where: { id }, include: { organization: true, documents: true } });
  if (!v) throw AppError.notFound('Verification');
  if (!['SUBMITTED', 'UNDER_REVIEW'].includes(v.status)) throw AppError.conflict(`Verification is ${v.status.toLowerCase().replace(/_/g, ' ')} and cannot be decided`, 'INVALID_TRANSITION');
  if (decision !== 'APPROVE' && !note?.trim()) throw AppError.unprocessable('A note explaining the decision is required', 'NOTE_REQUIRED', [{ field: 'note', message: 'Required' }]);
  if (decision === 'APPROVE' && v.documents.some((d) => d.status === 'REJECTED' || d.status === 'REPLACEMENT_REQUESTED')) {
    throw AppError.conflict('Some documents are rejected or need replacement — request more information instead', 'DOCUMENTS_NOT_APPROVED');
  }
  const orgId = v.organizationId;
  const reviewerId = actorUserId(actor);
  const status = decision === 'APPROVE' ? 'APPROVED' : decision === 'REJECT' ? 'REJECTED' : 'MORE_INFORMATION_REQUIRED';

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.verification.updateMany({
      where: { id, status: v.status },
      data: { status, reviewNote: note ?? null, reviewedAt: new Date(), reviewedById: reviewerId },
    });
    if (claimed.count === 0) throw AppError.conflict('Verification was modified concurrently', 'CONCURRENT_UPDATE');
    await recordReview(tx, v, decision, v.status, status, note, actor);
    const memberIds = (await tx.organizationMember.findMany({ where: { organizationId: orgId }, select: { userId: true } })).map((m) => m.userId);

    if (decision === 'APPROVE') {
      await tx.verificationDocument.updateMany({ where: { verificationId: id, status: 'PENDING' }, data: { status: 'APPROVED', reviewedAt: new Date(), reviewedById: reviewerId } });
      await tx.organization.update({ where: { id: orgId }, data: { status: 'ACTIVE', approvedAt: new Date(), statusReason: null } });
      await tx.user.updateMany({ where: { id: { in: memberIds }, status: { in: ['PENDING_REVIEW', 'REJECTED'] } }, data: { status: 'ACTIVE', statusReason: null } });
      await audit({ actor, action: 'BUSINESS_APPROVED', resource: 'organization', resourceId: orgId, organizationId: orgId, metadata: { verificationId: id }, meta }, tx);
      await audit({ actor, action: 'USER_APPROVED', resource: 'user', resourceId: memberIds[0] ?? null, organizationId: orgId, metadata: { userIds: memberIds }, meta }, tx);
    } else if (decision === 'REJECT') {
      await tx.organization.update({ where: { id: orgId }, data: { status: 'REJECTED', statusReason: note } });
      await tx.user.updateMany({ where: { id: { in: memberIds }, status: 'PENDING_REVIEW' }, data: { status: 'REJECTED', statusReason: note } });
      await audit({ actor, action: 'BUSINESS_REJECTED', resource: 'organization', resourceId: orgId, organizationId: orgId, metadata: { verificationId: id, note }, meta }, tx);
    } else {
      await tx.organization.update({ where: { id: orgId }, data: { status: 'DRAFT', statusReason: note } });
      await audit({ actor, action: 'VERIFICATION_MORE_INFORMATION_REQUESTED', resource: 'verification', resourceId: id, organizationId: orgId, metadata: { note }, meta }, tx);
    }
  });

  const messages = {
    APPROVE: { type: 'ACCOUNT_APPROVED' as const, title: 'Your account is approved 🎉', body: 'Your organization is verified. Request a sender ID and buy SMS credits to start sending.' },
    REJECT: { type: 'ACCOUNT_REJECTED' as const, title: 'Verification rejected', body: note ?? '' },
    REQUEST_INFORMATION: { type: 'VERIFICATION_CHANGES_REQUESTED' as const, title: 'More information needed for your verification', body: note ?? '' },
  };
  await notifyOrganization(orgId, { ...messages[decision], link: decision === 'APPROVE' ? '/app' : '/onboarding' });
}

/**
 * Keeps the verification record in step with organization suspension so the verification
 * history shows SUSPENDED (and back to APPROVED on reinstatement). Called inside the
 * suspension transaction.
 */
export async function syncVerificationSuspension(tx: Tx, organizationId: string, suspended: boolean, note: string | undefined, actor: Actor) {
  const v = await tx.verification.findFirst({ where: { organizationId }, orderBy: { createdAt: 'desc' } });
  if (!v) return;
  if (suspended && v.status === 'APPROVED') {
    await tx.verification.update({ where: { id: v.id }, data: { status: 'SUSPENDED', reviewNote: note ?? null } });
    await recordReview(tx, v, 'SUSPEND', v.status, 'SUSPENDED', note, actor);
  } else if (!suspended && v.status === 'SUSPENDED') {
    await tx.verification.update({ where: { id: v.id }, data: { status: 'APPROVED' } });
    await recordReview(tx, v, 'REINSTATE', v.status, 'APPROVED', note, actor);
  }
}
