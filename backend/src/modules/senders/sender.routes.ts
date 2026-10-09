import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/prisma';
import { requireOrgPermission } from '../../middlewares/rbac';
import { actorFromRequest, metaFromRequest } from '../../types/actor';
import { asyncHandler, created, ok, parse, uuidParam } from '../../utils/http';
import * as allocations from './allocation.service';
import * as svc from './sender.service';
import * as networks from './senderNetworks.service';

export const senderRouter = Router();

const requestBody = z.object({
  name: svc.senderNameSchema,
  purpose: z.string().trim().min(10, 'Describe the purpose in at least 10 characters').max(1000),
  sampleMessage: z.string().trim().max(640).optional().nullable(),
  useCase: z.string().trim().max(80).optional().nullable(),
  // Telecoms this sender ID will send to (e.g. MTN only, Airtel only, or both). Empty = any network.
  networkIds: z.array(z.string().uuid()).max(20).optional(),
});

senderRouter.get(
  '/',
  requireOrgPermission('senders.view'),
  asyncHandler(async (req, res) => {
    const q = parse(z.object({ status: z.enum(['PENDING', 'UNDER_REVIEW', 'NEEDS_INFORMATION', 'APPROVED', 'REJECTED', 'SUSPENDED']).optional() }), req.query);
    const senders = await prisma.senderId.findMany({
      where: { organizationId: req.org!.id, ...(q.status ? { status: q.status } : {}) },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    });
    return ok(res, senders);
  }),
);

// ── Destination network compatibility ───────────────────────────────────

/**
 * Sender IDs usable for every given destination network (comma-separated ids), each with its per-network
 * status, so the composer offers only compatible sender IDs and explains why the others cannot be used.
 */
senderRouter.get(
  '/eligible',
  requireOrgPermission('senders.view'),
  asyncHandler(async (req, res) => {
    const { networkIds } = parse(z.object({ networkIds: z.string().trim().max(2000).optional() }), req.query);
    const ids = networkIds ? [...new Set(networkIds.split(',').map((s) => s.trim()).filter(Boolean))] : [];
    const parsedIds = parse(z.array(z.string().uuid()).max(50), ids);
    const nets = await prisma.smsNetwork.findMany({ where: { id: { in: parsedIds } } });
    if (nets.length !== parsedIds.length) return ok(res, []);
    const senders = await prisma.senderId.findMany({ where: { organizationId: req.org!.id, status: 'APPROVED' }, orderBy: { name: 'asc' } });
    const out = [];
    for (const s of senders) {
      const checks = await networks.senderCompatibility(prisma, s, nets);
      out.push({ id: s.id, name: s.name, compatible: checks.every((c) => c.compatible), networks: checks });
    }
    return ok(res, out);
  }),
);

senderRouter.get(
  '/:id/networks',
  requireOrgPermission('senders.view'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const sender = await prisma.senderId.findFirst({ where: { id, organizationId: req.org!.id } });
    if (!sender) return ok(res, []);
    return ok(res, await networks.senderNetworkOverview(prisma, sender));
  }),
);

/** Ask for the sender ID to be registered on destination networks that require it. */
senderRouter.post(
  '/:id/networks',
  requireOrgPermission('senders.request'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const { networkIds } = parse(z.object({ networkIds: z.array(z.string().uuid()).min(1).max(50) }), req.body);
    return ok(res, await networks.requestSenderNetworks(req.org!.id, id, networkIds, actorFromRequest(req), metaFromRequest(req)), 'Network registration requested');
  }),
);

// ── Credit allocations ──────────────────────────────────────────────────

/** Wallet balance, credits reserved by allocations and every allocation with its usage. */
senderRouter.get(
  '/allocations',
  requireOrgPermission('senders.view'),
  asyncHandler(async (req, res) => ok(res, await allocations.allocationOverview(req.org!.id))),
);

const allocationBody = z.object({
  allocated: z.coerce.number().int().min(1, 'Allocate at least 1 credit').max(100_000_000),
  alertThresholds: z
    .array(z.coerce.number().int().min(1).max(99))
    .max(5)
    .refine((t) => new Set(t).size === t.length, 'Thresholds must be different')
    .optional(),
});

senderRouter.put(
  '/:id/allocation',
  requireOrgPermission('senders.allocate'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(allocationBody, req.body);
    return ok(res, await allocations.setAllocation(req.org!.id, id, body, actorFromRequest(req), metaFromRequest(req)), 'Allocation saved');
  }),
);

senderRouter.delete(
  '/:id/allocation',
  requireOrgPermission('senders.allocate'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    await allocations.removeAllocation(req.org!.id, id, actorFromRequest(req), metaFromRequest(req));
    return ok(res, null, 'Allocation removed; its credits are available to all sender IDs again');
  }),
);

senderRouter.post(
  '/',
  requireOrgPermission('senders.request'),
  asyncHandler(async (req, res) => {
    const body = parse(requestBody, req.body);
    const s = await svc.requestSender(req.org!.id, body, actorFromRequest(req), metaFromRequest(req));
    return created(res, s, 'Sender ID submitted for review');
  }),
);

senderRouter.patch(
  '/:id',
  requireOrgPermission('senders.request'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(requestBody.partial(), req.body);
    return ok(res, await svc.updateSenderRequest(req.org!.id, id, body, actorFromRequest(req), metaFromRequest(req)), 'Sender ID updated');
  }),
);

senderRouter.post(
  '/:id/submit',
  requireOrgPermission('senders.request'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    return ok(res, await svc.resubmitSender(req.org!.id, id, actorFromRequest(req), metaFromRequest(req)), 'Sender ID resubmitted for review');
  }),
);

senderRouter.delete(
  '/:id',
  requireOrgPermission('senders.request'),
  asyncHandler(async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    await svc.deleteSenderRequest(req.org!.id, id, actorFromRequest(req), metaFromRequest(req));
    return ok(res, null, 'Sender ID request withdrawn');
  }),
);
