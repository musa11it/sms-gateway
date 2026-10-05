import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { requireOrgPermission } from '../../middlewares/rbac';
import { csvUpload, } from '../../middlewares/upload';
import { uploadLimiter } from '../../middlewares/rateLimit';
import { actorFromRequest, metaFromRequest } from '../../types/actor';
import { AppError } from '../../utils/errors';
import { asyncHandler, created, ok, paginated, paginationSchema, parse, toSkipTake, uuidParam } from '../../utils/http';
import { stringList } from '../../utils/json';
import { normalizePhone } from '../../utils/phone';
import { audit } from '../audit-logs/audit.service';
import { getSetting } from '../settings/settings.service';
import { analyzeCsv } from './contact.service';

export const contactRouter = Router();

const contactBody = z.object({
  name: z.string().trim().max(120).optional().nullable(),
  phone: z.string().trim().min(3).max(30),
  email: z.string().trim().email().max(200).optional().nullable().or(z.literal('').transform(() => null)),
  tags: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
  status: z.enum(['ACTIVE', 'UNSUBSCRIBED', 'BLOCKED']).optional(),
  groupIds: z.array(z.string().uuid()).max(50).optional(),
});

async function normalizeOrThrow(phone: string) {
  const normalized = normalizePhone(phone, await getSetting('sms.defaultCountryCode'));
  if (!normalized) throw AppError.unprocessable('Invalid phone number', 'INVALID_PHONE', [{ field: 'phone', message: 'Enter a valid phone number, e.g. +250788123456' }]);
  return normalized;
}

async function assertGroups(organizationId: string, ids?: string[]) {
  if (!ids?.length) return;
  const count = await prisma.contactGroup.count({ where: { organizationId, id: { in: ids } } });
  if (count !== new Set(ids).size) throw AppError.unprocessable('One or more groups were not found', 'GROUP_NOT_FOUND');
}

const listQuery = paginationSchema.extend({
  search: z.string().trim().max(100).optional(),
  groupId: z.string().uuid().optional(),
  status: z.enum(['ACTIVE', 'UNSUBSCRIBED', 'BLOCKED']).optional(),
  tag: z.string().trim().max(40).optional(),
});

function contactWhere(orgId: string, q: z.infer<typeof listQuery>): Prisma.ContactWhereInput {
  return {
    organizationId: orgId,
    ...(q.status ? { status: q.status } : {}),
    ...(q.tag ? { tags: { path: '$', array_contains: [q.tag] } } : {}),
    ...(q.groupId ? { groups: { some: { groupId: q.groupId } } } : {}),
    ...(q.search
      ? { OR: [{ name: { contains: q.search } }, { phone: { contains: q.search.replace(/\s/g, '') } }, { email: { contains: q.search } }] }
      : {}),
  };
}

contactRouter.get(
  '/',
  requireOrgPermission('contacts.view'),
  asyncHandler(async (req, res) => {
    const q = parse(listQuery, req.query);
    const where = contactWhere(req.org!.id, q);
    const [items, total] = await Promise.all([
      prisma.contact.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...toSkipTake(q),
        include: { groups: { include: { group: { select: { id: true, name: true, color: true } } } } },
      }),
      prisma.contact.count({ where }),
    ]);
    return paginated(res, items.map(({ groups, ...c }) => ({ ...c, groups: groups.map((g) => g.group) })), q.page, q.limit, total);
  }),
);

contactRouter.get(
  '/export',
  requireOrgPermission('contacts.view'),
  asyncHandler(async (req, res) => {
    const q = parse(listQuery.omit({ page: true, limit: true }), req.query);
    const items = await prisma.contact.findMany({ where: contactWhere(req.org!.id, { ...q, page: 1, limit: 1 }), orderBy: { createdAt: 'asc' }, take: 100_000 });
    const esc = (v: string | null) => {
      const s = v ?? '';
      // Prevent CSV formula injection when opened in spreadsheet software.
      const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
      return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const csv = ['name,phone,email,tags,status', ...items.map((c) => [esc(c.name), esc(c.phone), esc(c.email), esc(stringList(c.tags).join(';')), c.status].join(','))].join('\n');
    await audit({ actor: actorFromRequest(req), action: 'CONTACTS_EXPORTED', resource: 'contact', organizationId: req.org!.id, metadata: { count: items.length }, meta: metaFromRequest(req) });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="contacts-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  }),
);

contactRouter.post(
  '/',
  requireOrgPermission('contacts.create'),
  asyncHandler(async (req, res) => {
    const body = parse(contactBody, req.body);
    const phone = await normalizeOrThrow(body.phone);
    await assertGroups(req.org!.id, body.groupIds);
    const exists = await prisma.contact.findUnique({ where: { organizationId_phone: { organizationId: req.org!.id, phone } } });
    if (exists) throw AppError.conflict('A contact with this phone number already exists', 'DUPLICATE_CONTACT');
    const contact = await prisma.contact.create({
      data: {
        organizationId: req.org!.id,
        name: body.name || null,
        phone,
        email: body.email || null,
        tags: body.tags ?? [],
        status: body.status ?? 'ACTIVE',
        groups: body.groupIds?.length ? { create: body.groupIds.map((groupId) => ({ groupId })) } : undefined,
      },
    });
    return created(res, contact, 'Contact created');
  }),
);

contactRouter.get(
  '/:id',
  requireOrgPermission('contacts.view'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const contact = await prisma.contact.findFirst({
      where: { id, organizationId: req.org!.id },
      include: { groups: { include: { group: true } } },
    });
    if (!contact) throw AppError.notFound('Contact');
    return ok(res, { ...contact, groups: contact.groups.map((g) => g.group) });
  }),
);

contactRouter.patch(
  '/:id',
  requireOrgPermission('contacts.update'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(contactBody.partial(), req.body);
    const contact = await prisma.contact.findFirst({ where: { id, organizationId: req.org!.id } });
    if (!contact) throw AppError.notFound('Contact');
    const phone = body.phone ? await normalizeOrThrow(body.phone) : undefined;
    await assertGroups(req.org!.id, body.groupIds);
    const updated = await prisma.$transaction(async (tx) => {
      if (body.groupIds) {
        await tx.contactGroupMember.deleteMany({ where: { contactId: id } });
        if (body.groupIds.length) await tx.contactGroupMember.createMany({ data: body.groupIds.map((groupId) => ({ groupId, contactId: id })) });
      }
      return tx.contact.update({
        where: { id },
        data: { name: body.name, phone, email: body.email, tags: body.tags, status: body.status },
      });
    });
    return ok(res, updated, 'Contact updated');
  }),
);

contactRouter.delete(
  '/:id',
  requireOrgPermission('contacts.delete'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const result = await prisma.contact.deleteMany({ where: { id, organizationId: req.org!.id } });
    if (result.count === 0) throw AppError.notFound('Contact');
    return ok(res, null, 'Contact deleted');
  }),
);

contactRouter.post(
  '/bulk-delete',
  requireOrgPermission('contacts.delete'),
  asyncHandler(async (req, res) => {
    const { ids } = parse(z.object({ ids: z.array(z.string().uuid()).min(1).max(1000) }), req.body);
    const result = await prisma.contact.deleteMany({ where: { id: { in: ids }, organizationId: req.org!.id } });
    await audit({ actor: actorFromRequest(req), action: 'CONTACTS_DELETED', resource: 'contact', organizationId: req.org!.id, metadata: { count: result.count }, meta: metaFromRequest(req) });
    return ok(res, { deleted: result.count }, `${result.count} contact(s) deleted`);
  }),
);

// ── CSV import (two-step: preview → commit) ─────────────────────────────

contactRouter.post(
  '/import/preview',
  uploadLimiter,
  requireOrgPermission('contacts.import'),
  csvUpload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw AppError.badRequest('Attach a CSV file in the "file" field', 'FILE_REQUIRED');
    const analysis = await analyzeCsv(req.org!.id, req.file.buffer.toString('utf8'));
    return ok(res, analysis);
  }),
);

contactRouter.post(
  '/import/commit',
  uploadLimiter,
  requireOrgPermission('contacts.import'),
  csvUpload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw AppError.badRequest('Attach a CSV file in the "file" field', 'FILE_REQUIRED');
    const opts = parse(
      z.object({ groupId: z.string().uuid().optional().or(z.literal('').transform(() => undefined)), updateExisting: z.enum(['true', 'false']).optional() }),
      req.body,
    );
    if (opts.groupId) await assertGroups(req.org!.id, [opts.groupId]);
    // Re-analyse server-side: the client preview is never trusted.
    const analysis = await analyzeCsv(req.org!.id, req.file.buffer.toString('utf8'));
    const toCreate = analysis.rows.filter((r) => r.status === 'valid');
    const toUpdate = opts.updateExisting === 'true' ? analysis.rows.filter((r) => r.status === 'existing') : [];
    const orgId = req.org!.id;

    await prisma.$transaction(
      async (tx) => {
        for (let i = 0; i < toCreate.length; i += 1000) {
          await tx.contact.createMany({
            data: toCreate.slice(i, i + 1000).map((r) => ({ organizationId: orgId, name: r.name, phone: r.phone!, email: r.email, tags: r.tags })),
            skipDuplicates: true,
          });
        }
        for (const r of toUpdate) {
          await tx.contact.update({
            where: { organizationId_phone: { organizationId: orgId, phone: r.phone! } },
            data: { ...(r.name ? { name: r.name } : {}), ...(r.email ? { email: r.email } : {}), ...(r.tags.length ? { tags: r.tags } : {}) },
          });
        }
        if (opts.groupId) {
          const phones = [...toCreate, ...analysis.rows.filter((r) => r.status === 'existing')].map((r) => r.phone!);
          const contacts = await tx.contact.findMany({ where: { organizationId: orgId, phone: { in: phones } }, select: { id: true } });
          await tx.contactGroupMember.createMany({ data: contacts.map((c) => ({ groupId: opts.groupId!, contactId: c.id })), skipDuplicates: true });
        }
      },
      { timeout: 120_000 },
    );
    await audit({
      actor: actorFromRequest(req),
      action: 'CONTACTS_IMPORTED',
      resource: 'contact',
      organizationId: orgId,
      metadata: { ...analysis.summary, created: toCreate.length, updated: toUpdate.length, groupId: opts.groupId },
      meta: metaFromRequest(req),
    });
    return ok(res, { ...analysis.summary, created: toCreate.length, updated: toUpdate.length }, `${toCreate.length} contact(s) imported`);
  }),
);

// ── Groups ──────────────────────────────────────────────────────────────

export const groupRouter = Router();

const groupBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).optional().nullable(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().nullable(),
});

groupRouter.get(
  '/',
  requireOrgPermission('contacts.view'),
  asyncHandler(async (req, res) => {
    const groups = await prisma.contactGroup.findMany({
      where: { organizationId: req.org!.id },
      orderBy: { name: 'asc' },
      include: { _count: { select: { members: true } } },
    });
    return ok(res, groups.map(({ _count, ...g }) => ({ ...g, contactCount: _count.members })));
  }),
);

groupRouter.post(
  '/',
  requireOrgPermission('contacts.create'),
  asyncHandler(async (req, res) => {
    const body = parse(groupBody, req.body);
    const exists = await prisma.contactGroup.findUnique({ where: { organizationId_name: { organizationId: req.org!.id, name: body.name } } });
    if (exists) throw AppError.conflict('A group with this name already exists', 'DUPLICATE_GROUP');
    const group = await prisma.contactGroup.create({ data: { ...body, organizationId: req.org!.id } });
    return created(res, group, 'Group created');
  }),
);

groupRouter.patch(
  '/:id',
  requireOrgPermission('contacts.update'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(groupBody.partial(), req.body);
    const group = await prisma.contactGroup.findFirst({ where: { id, organizationId: req.org!.id } });
    if (!group) throw AppError.notFound('Group');
    return ok(res, await prisma.contactGroup.update({ where: { id }, data: body }), 'Group updated');
  }),
);

groupRouter.delete(
  '/:id',
  requireOrgPermission('contacts.delete'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const group = await prisma.contactGroup.findFirst({ where: { id, organizationId: req.org!.id }, include: { _count: { select: { campaigns: true } } } });
    if (!group) throw AppError.notFound('Group');
    if (group._count.campaigns > 0) throw AppError.conflict('This group is used by a campaign and cannot be deleted', 'GROUP_IN_USE');
    await prisma.contactGroup.delete({ where: { id } });
    return ok(res, null, 'Group deleted (contacts were kept)');
  }),
);

groupRouter.post(
  '/:id/members',
  requireOrgPermission('contacts.update'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const { contactIds } = parse(z.object({ contactIds: z.array(z.string().uuid()).min(1).max(5000) }), req.body);
    const group = await prisma.contactGroup.findFirst({ where: { id, organizationId: req.org!.id } });
    if (!group) throw AppError.notFound('Group');
    const contacts = await prisma.contact.findMany({ where: { id: { in: contactIds }, organizationId: req.org!.id }, select: { id: true } });
    const result = await prisma.contactGroupMember.createMany({ data: contacts.map((c) => ({ groupId: id, contactId: c.id })), skipDuplicates: true });
    return ok(res, { added: result.count }, `${result.count} contact(s) added to ${group.name}`);
  }),
);

groupRouter.delete(
  '/:id/members/:contactId',
  requireOrgPermission('contacts.update'),
  asyncHandler(async (req, res) => {
    const { id, contactId } = parse(z.object({ id: z.string().uuid(), contactId: z.string().uuid() }), req.params);
    const group = await prisma.contactGroup.findFirst({ where: { id, organizationId: req.org!.id } });
    if (!group) throw AppError.notFound('Group');
    await prisma.contactGroupMember.deleteMany({ where: { groupId: id, contactId } });
    return ok(res, null, 'Removed from group');
  }),
);
