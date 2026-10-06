import { Prisma } from '@prisma/client';
import { prisma, type Tx } from '../../config/prisma';
import type { Actor, RequestMeta } from '../../types/actor';
import { actorUserId } from '../../types/actor';
import { AppError } from '../../utils/errors';
import { normalizePhone } from '../../utils/phone';
import { audit } from '../audit-logs/audit.service';
import { generatePassword, hashPassword } from '../auth/password';
import { sendAccountSetupEmail } from '../auth/auth.service';
import { createOrganizationWithOwner } from './organization.helpers';

/**
 * Platform staff creating organizations and giving people access to them. New accounts get a
 * system-generated password, returned once to the admin to hand over (it is never stored in plain
 * text, logged, or put in an email). The person also gets a link to choose their own password.
 */

export interface PersonInput {
  fullName: string;
  email: string;
  phone?: string;
}

/** Finds the account for this email, or creates one (no usable password until the person sets one). */
async function findOrCreateUser(tx: Tx, person: PersonInput, status: 'ACTIVE' | 'PENDING_REVIEW') {
  const email = person.email.toLowerCase().trim();
  const existing = await tx.user.findUnique({ where: { email } });
  if (existing) {
    if (existing.isServiceAccount) throw AppError.conflict('This email belongs to a service account', 'EMAIL_RESERVED');
    if (existing.status === 'DEACTIVATED') throw AppError.conflict('This account is deactivated', 'USER_DEACTIVATED');
    return { user: existing, created: false, temporaryPassword: null };
  }
  const phone = person.phone ? normalizePhone(person.phone) : null;
  if (person.phone && !phone) throw AppError.unprocessable('Invalid phone number', 'INVALID_PHONE', [{ field: 'owner.phone', message: 'Invalid phone number' }]);
  if (phone && (await tx.user.findUnique({ where: { phone } }))) throw AppError.conflict('An account with this phone number already exists', 'PHONE_TAKEN');
  const temporaryPassword = generatePassword();
  const user = await tx.user.create({
    data: {
      email,
      phone,
      fullName: person.fullName.trim(),
      passwordHash: await hashPassword(temporaryPassword),
      status,
      // An administrator vouches for the address; the setup link below proves the person controls it.
      emailVerifiedAt: new Date(),
    },
  });
  return { user, created: true, temporaryPassword };
}

export interface CreateOrganizationInput {
  name: string;
  profile: Partial<Record<'businessType' | 'country' | 'city' | 'address' | 'registrationNumber' | 'taxId' | 'website' | 'contactPersonName' | 'contactPersonPhone' | 'contactPersonEmail' | 'smsPurpose', string>> & { expectedMonthlyVolume?: number };
  owner: PersonInput;
  /** Skip verification: the organization (and its owner) become ACTIVE immediately. */
  activate: boolean;
  apiAccess?: { enabled: boolean; allowedScopes: string[] | null };
}

export async function createOrganizationByAdmin(input: CreateOrganizationInput, actor: Actor, meta?: RequestMeta) {
  const adminId = actorUserId(actor);
  const result = await prisma.$transaction(async (tx) => {
    const { user, created, temporaryPassword } = await findOrCreateUser(tx, input.owner, input.activate ? 'ACTIVE' : 'PENDING_REVIEW');
    const base = await createOrganizationWithOwner(tx, { name: input.name.trim(), ownerId: user.id });
    const org = await tx.organization.update({
      where: { id: base.id },
      data: {
        // The owner is the contact person unless the caller says otherwise, so nothing is asked twice.
        contactPersonName: input.owner.fullName.trim(),
        contactPersonPhone: input.owner.phone?.trim() || undefined,
        contactPersonEmail: input.owner.email.toLowerCase().trim(),
        ...Object.fromEntries(Object.entries(input.profile).filter(([, v]) => v !== undefined)),
        ...(input.apiAccess ? { apiAccessEnabled: input.apiAccess.enabled, apiAllowedScopes: input.apiAccess.allowedScopes ?? Prisma.DbNull } : {}),
        ...(input.activate ? { status: 'ACTIVE', approvedAt: new Date() } : {}),
      },
    });
    if (input.activate) {
      const v = await tx.verification.findFirstOrThrow({ where: { organizationId: org.id } });
      const note = 'Created and approved by a platform administrator';
      await tx.verification.update({ where: { id: v.id }, data: { status: 'APPROVED', reviewedAt: new Date(), reviewedById: adminId, reviewNote: note } });
      await tx.verificationReview.create({ data: { verificationId: v.id, organizationId: org.id, reviewerId: adminId, action: 'ADMIN_CREATED_APPROVED', fromStatus: 'DRAFT', toStatus: 'APPROVED', note } });
      if (user.status === 'PENDING_REVIEW' || user.status === 'REJECTED') await tx.user.update({ where: { id: user.id }, data: { status: 'ACTIVE', statusReason: null } });
    }
    if (created) await audit({ actor, action: 'USER_CREATED', resource: 'user', resourceId: user.id, organizationId: org.id, metadata: { byStaff: true }, meta }, tx);
    await audit({ actor, action: 'ORGANIZATION_CREATED', resource: 'organization', resourceId: org.id, organizationId: org.id, metadata: { byStaff: true, activated: input.activate, ownerId: user.id, ownerCreated: created }, meta }, tx);
    if (input.activate) await audit({ actor, action: 'BUSINESS_APPROVED', resource: 'organization', resourceId: org.id, organizationId: org.id, metadata: { byStaff: true, skippedVerification: true }, meta }, tx);
    return { org, user, created, temporaryPassword };
  });
  // Only brand-new accounts need a password link; existing users already sign in.
  if (result.created) await sendAccountSetupEmail(result.user, result.org.name);
  return { organization: result.org, owner: { id: result.user.id, email: result.user.email, fullName: result.user.fullName, created: result.created, temporaryPassword: result.temporaryPassword } };
}

/** Gives a person (existing or new) access to an existing organization with one of its roles. */
export async function grantOrganizationAccess(organizationId: string, input: { person: PersonInput; roleId: string }, actor: Actor, meta?: RequestMeta) {
  const org = await prisma.organization.findUnique({ where: { id: organizationId } });
  if (!org) throw AppError.notFound('Organization');
  const role = await prisma.role.findFirst({ where: { id: input.roleId, scope: 'ORGANIZATION', OR: [{ organizationId: null }, { organizationId }] } });
  if (!role) throw AppError.unprocessable('Choose a valid role for this organization', 'INVALID_ROLE', [{ field: 'roleId', message: 'Invalid role' }]);
  if (role.code === 'CUSTOMER_OWNER') throw AppError.unprocessable('Ownership is set when the organization is created', 'OWNER_ROLE_RESERVED', [{ field: 'roleId', message: 'Pick a non-owner role' }]);

  const result = await prisma.$transaction(async (tx) => {
    const { user, created, temporaryPassword } = await findOrCreateUser(tx, input.person, org.status === 'ACTIVE' ? 'ACTIVE' : 'PENDING_REVIEW');
    if (await tx.organizationMember.findUnique({ where: { organizationId_userId: { organizationId, userId: user.id } } })) {
      throw AppError.conflict('This person already has access to the organization', 'ALREADY_MEMBER');
    }
    const member = await tx.organizationMember.create({ data: { organizationId, userId: user.id, roleId: role.id } });
    if (created) await audit({ actor, action: 'USER_CREATED', resource: 'user', resourceId: user.id, organizationId, metadata: { byStaff: true }, meta }, tx);
    await audit({ actor, action: 'MEMBER_ACCESS_GRANTED', resource: 'organization_member', resourceId: member.id, organizationId, metadata: { userId: user.id, role: role.code, byStaff: true }, meta }, tx);
    return { member, user, created, temporaryPassword };
  });
  if (result.created) await sendAccountSetupEmail(result.user, org.name);
  return { memberId: result.member.id, user: { id: result.user.id, email: result.user.email, fullName: result.user.fullName, created: result.created, temporaryPassword: result.temporaryPassword }, role: { id: role.id, name: role.name } };
}
