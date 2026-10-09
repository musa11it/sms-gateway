import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { requireOrgPermission } from '../../middlewares/rbac';
import { actorFromRequest, metaFromRequest } from '../../types/actor';
import { AppError } from '../../utils/errors';
import { asyncHandler, created, ok, paginated, paginationSchema, parse, toSkipTake, uuidParam } from '../../utils/http';
import { getSetting } from '../settings/settings.service';
import { streamInvoicePdf } from '../invoices/invoicePdf';
import * as svc from './payment.service';
import { calculateSmsPurchasePrice } from '../pricing/pricing.service';
import { quoteNetworkPurchase } from '../pricing/networkPricing.service';

export const paymentRouter = Router();

paymentRouter.get(
  '/',
  requireOrgPermission('payments.view'),
  asyncHandler(async (req, res) => {
    const q = parse(paginationSchema.extend({ status: z.enum(['PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'CANCELLED', 'REFUNDED']).optional() }), req.query);
    const where: Prisma.PaymentWhereInput = { organizationId: req.org!.id, ...(q.status ? { status: q.status } : {}) };
    const [items, total] = await Promise.all([
      prisma.payment.findMany({ where, orderBy: { createdAt: 'desc' }, ...toSkipTake(q), include: { invoice: { select: { id: true, number: true } }, items: true } }),
      prisma.payment.count({ where }),
    ]);
    return paginated(res, items.map(svc.serializePayment), q.page, q.limit, total);
  }),
);

/**
 * The exact quote checkout will charge this organization: same engine as POST /payments, including
 * monthly-volume tiers (which count this organization's purchases this month). Informational only.
 */
paymentRouter.post(
  '/quote',
  requireOrgPermission('wallet.purchase', 'payments.create'),
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ items: z.unknown().optional(), quantity: z.unknown().optional() }).strict(), req.body);
    if (body.items !== undefined) return ok(res, await quoteNetworkPurchase(body.items, prisma, { organizationId: req.org!.id }));
    return ok(res, await calculateSmsPurchasePrice(body.quantity, prisma, { organizationId: req.org!.id }));
  }),
);

paymentRouter.post(
  '/',
  requireOrgPermission('wallet.purchase', 'payments.create'),
  asyncHandler(async (req, res) => {
    const body = parse(
      // Either `items` (SMS for destination networks: [{ networkId, quantity }]) or `quantity` (general
      // credits). Prices, totals and discounts are always computed by the server: client-sent ones are rejected.
      z
        .object({
          packageId: z.unknown().optional(),
          quantity: z.unknown().optional(),
          items: z.unknown().optional(),
          method: z.enum(['MOBILE_MONEY', 'CARD', 'BANK_TRANSFER']),
          payerPhone: z.string().trim().max(30).optional().nullable(),
          unitPrice: z.unknown().optional(),
          amount: z.unknown().optional(),
          total: z.unknown().optional(),
          discount: z.unknown().optional(),
        })
        .refine((b) => b.packageId === undefined, { message: 'SMS packages are no longer sold. Enter the quantity of SMS credits to buy.', path: ['packageId'] })
        // Network purchases refuse client prices outright; the original quantity API keeps ignoring them (existing contract).
        .refine((b) => b.items === undefined || (b.unitPrice === undefined && b.amount === undefined && b.total === undefined && b.discount === undefined), {
          message: 'Prices are calculated by the server and cannot be submitted',
          path: ['amount'],
        })
        .refine((b) => b.quantity !== undefined || b.items !== undefined, { message: 'Enter the quantity of SMS to buy', path: ['quantity'] })
        .refine((b) => b.quantity === undefined || b.items === undefined, { message: 'Send either items (per network) or quantity (general credits), not both', path: ['items'] }),
      req.body,
    );
    const result = await svc.createPayment(req.org!.id, { quantity: body.quantity, items: body.items, method: body.method, payerPhone: body.payerPhone }, actorFromRequest(req), metaFromRequest(req));
    return created(res, result, 'Payment initiated');
  }),
);

paymentRouter.get(
  '/:id',
  requireOrgPermission('payments.view'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const p = await prisma.payment.findFirst({ where: { id, organizationId: req.org!.id }, include: { invoice: { select: { id: true, number: true } }, items: true } });
    if (!p) throw AppError.notFound('Payment');
    return ok(res, svc.serializePayment(p));
  }),
);

/** Customer "check status" — asks the provider; never trusts client-side claims of success. */
paymentRouter.post(
  '/:id/verify',
  requireOrgPermission('payments.view'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const p = await prisma.payment.findFirst({ where: { id, organizationId: req.org!.id } });
    if (!p) throw AppError.notFound('Payment');
    await svc.verifyAndApply(p.id, actorFromRequest(req), metaFromRequest(req));
    const updated = await prisma.payment.findUniqueOrThrow({ where: { id }, include: { invoice: { select: { id: true, number: true } }, items: true } });
    return ok(res, svc.serializePayment(updated));
  }),
);

paymentRouter.post(
  '/:id/cancel',
  requireOrgPermission('payments.create'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    await svc.cancelPayment(req.org!.id, id, actorFromRequest(req), metaFromRequest(req));
    return ok(res, null, 'Payment cancelled');
  }),
);

paymentRouter.post(
  '/:id/simulate',
  requireOrgPermission('payments.create'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const { action } = parse(z.object({ action: z.enum(['APPROVE', 'DECLINE']) }), req.body);
    await svc.simulatePayerAction(req.org!.id, id, action);
    return ok(res, null, action === 'APPROVE' ? 'Approved on the simulated payer device. Waiting for provider confirmation…' : 'Declined on the simulated payer device');
  }),
);

export const invoiceRouter = Router();

export function serializeInvoice(i: Prisma.InvoiceGetPayload<{ include: { payment: true } }>) {
  return {
    id: i.id,
    number: i.number,
    customerName: i.customerName,
    customerEmail: i.customerEmail,
    billingAddress: i.billingAddress,
    taxId: i.taxId,
    description: i.description,
    quantity: i.quantity,
    unitPrice: i.unitPrice.toFixed(4),
    subtotal: i.subtotal.toFixed(2),
    taxRate: i.taxRate.toFixed(2),
    taxAmount: i.taxAmount.toFixed(2),
    total: i.total.toFixed(2),
    currency: i.currency,
    status: i.status,
    issuedAt: i.issuedAt,
    payment: { id: i.payment.id, reference: i.payment.reference, method: i.payment.method, status: i.payment.status, packageName: i.payment.packageName },
  };
}

invoiceRouter.get(
  '/',
  requireOrgPermission('invoices.view'),
  asyncHandler(async (req, res) => {
    const q = parse(paginationSchema, req.query);
    const where = { organizationId: req.org!.id };
    const [items, total] = await Promise.all([
      prisma.invoice.findMany({ where, orderBy: { issuedAt: 'desc' }, ...toSkipTake(q), include: { payment: true } }),
      prisma.invoice.count({ where }),
    ]);
    return paginated(res, items.map(serializeInvoice), q.page, q.limit, total);
  }),
);

invoiceRouter.get(
  '/:id/pdf',
  requireOrgPermission('invoices.view'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const inv = await prisma.invoice.findFirst({ where: { id, organizationId: req.org!.id }, include: { payment: true } });
    if (!inv) throw AppError.notFound('Invoice');
    streamInvoicePdf(res, serializeInvoice(inv) as unknown as Parameters<typeof streamInvoicePdf>[1], {
      name: await getSetting('billing.companyName'),
      address: await getSetting('billing.companyAddress'),
    });
  }),
);

invoiceRouter.get(
  '/:id',
  requireOrgPermission('invoices.view'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const inv = await prisma.invoice.findFirst({ where: { id, organizationId: req.org!.id }, include: { payment: true } });
    if (!inv) throw AppError.notFound('Invoice');
    return ok(res, { ...serializeInvoice(inv), issuer: { name: await getSetting('billing.companyName'), address: await getSetting('billing.companyAddress') } });
  }),
);
