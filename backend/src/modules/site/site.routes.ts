import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { isTest } from '../../config/env';
import { prisma } from '../../config/prisma';
import { requirePlatformPermission } from '../../middlewares/rbac';
import { actorFromRequest, metaFromRequest } from '../../types/actor';
import { AppError } from '../../utils/errors';
import { asyncHandler, created, ok, paginated, paginationSchema, parse, toSkipTake, uuidParam } from '../../utils/http';
import { audit } from '../audit-logs/audit.service';
import { notifyStaff } from '../notifications/notification.service';
import { activeTiers } from '../pricing/pricing.service';
import { countryDirectory, countryNetworks, destinationCatalog, quoteNetworkPurchase } from '../pricing/networkPricing.service';

/** Public website API (no authentication). */
export const siteRouter = Router();

const contactLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => isTest,
  handler: (_req, res) => res.status(429).json({ success: false, message: 'Too many messages. Please try again later.', code: 'RATE_LIMITED' }),
});

/** Current general-credit price ranges (any network) — prices come from admin configuration. */
siteRouter.get(
  '/pricing',
  asyncHandler(async (_req, res) => {
    const tiers = await activeTiers();
    return ok(
      res,
      tiers.map((t) => ({ id: t.id, name: t.name, minQuantity: t.minQuantity, maxQuantity: t.maxQuantity, unitPrice: t.unitPrice.toFixed(2), currency: t.currency })),
    );
  }),
);

/** Public pricing page: countries, services, networks, customer selling prices and availability (never provider data). */
siteRouter.get(
  '/destinations',
  asyncHandler(async (_req, res) => ok(res, await destinationCatalog(prisma, { includeUnavailableCountries: true }))),
);

const quoteLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => isTest,
  handler: (_req, res) => res.status(429).json({ success: false, message: 'Too many requests. Please slow down.', code: 'RATE_LIMITED' }),
});

/** Searchable country list (light: no prices per tier). `prefer` = ISO code or country name to open first. */
siteRouter.get(
  '/countries',
  asyncHandler(async (req, res) => {
    const q = parse(z.object({ search: z.string().trim().max(60).optional(), limit: z.coerce.number().int().min(1).max(50).optional(), prefer: z.string().trim().max(80).optional() }), req.query);
    return ok(res, await countryDirectory(q));
  }),
);

/** One country: its services, telecoms, prices and availability. */
siteRouter.get(
  '/countries/:isoCode',
  asyncHandler(async (req, res) => {
    const { isoCode } = parse(z.object({ isoCode: z.string().trim().length(2) }), req.params);
    return ok(res, await countryNetworks(isoCode));
  }),
);

/** Public price calculator: same engine as checkout, without account history (monthly-volume tiers count from zero). */
siteRouter.post(
  '/quote',
  quoteLimiter,
  asyncHandler(async (req, res) => {
    const { items } = parse(z.object({ items: z.unknown() }).strict(), req.body);
    return ok(res, await quoteNetworkPurchase(items));
  }),
);

siteRouter.post(
  '/contact',
  contactLimiter,
  asyncHandler(async (req, res) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(120),
        email: z.string().trim().email().max(200),
        phone: z.string().trim().max(30).optional().or(z.literal('').transform(() => undefined)),
        company: z.string().trim().max(160).optional().or(z.literal('').transform(() => undefined)),
        message: z.string().trim().min(10, 'Please write at least 10 characters').max(3000),
        website: z.string().max(0).optional(), // honeypot: must stay empty
      }),
      req.body,
    );
    const inquiry = await prisma.contactInquiry.create({
      data: { name: body.name, email: body.email, phone: body.phone, company: body.company, message: body.message, ipAddress: req.ip },
    });
    await notifyStaff('inquiries.view', { type: 'VERIFICATION_SUBMITTED', title: 'New website inquiry', body: `${body.name}${body.company ? ` (${body.company})` : ''}`, link: '/admin/inquiries' });
    return created(res, { id: inquiry.id }, 'Thanks! Our team will get back to you shortly.');
  }),
);

/** Admin: website inquiries. */
export const adminInquiriesRouter = Router();

adminInquiriesRouter.get(
  '/',
  requirePlatformPermission('inquiries.view'),
  asyncHandler(async (req, res) => {
    const q = parse(paginationSchema.extend({ status: z.enum(['NEW', 'HANDLED']).optional() }), req.query);
    const where = q.status ? { status: q.status } : {};
    const [items, total] = await Promise.all([prisma.contactInquiry.findMany({ where, orderBy: { createdAt: 'desc' }, ...toSkipTake(q) }), prisma.contactInquiry.count({ where })]);
    return paginated(res, items, q.page, q.limit, total);
  }),
);

adminInquiriesRouter.post(
  '/:id/handle',
  requirePlatformPermission('inquiries.view'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const r = await prisma.contactInquiry.updateMany({ where: { id, status: 'NEW' }, data: { status: 'HANDLED', handledAt: new Date(), handledById: req.user!.id } });
    if (r.count === 0) throw AppError.notFound('Open inquiry');
    await audit({ actor: actorFromRequest(req), action: 'INQUIRY_HANDLED', resource: 'contact_inquiry', resourceId: id, meta: metaFromRequest(req) });
    return ok(res, null, 'Marked as handled');
  }),
);
