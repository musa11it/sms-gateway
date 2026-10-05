import type { Request } from 'express';

export type Actor =
  | { type: 'USER'; userId: string; email?: string }
  | { type: 'API_KEY'; apiKeyId: string }
  | { type: 'SYSTEM' };

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

export const SYSTEM_ACTOR: Actor = { type: 'SYSTEM' };

export function actorFromRequest(req: Request): Actor {
  if (req.user) return { type: 'USER', userId: req.user.id, email: req.user.email };
  if (req.apiKey) return { type: 'API_KEY', apiKeyId: req.apiKey.id };
  return SYSTEM_ACTOR;
}

export function metaFromRequest(req: Request): RequestMeta {
  return { ip: req.ip, userAgent: req.get('user-agent') ?? undefined, requestId: String(req.id) };
}

export function actorUserId(actor: Actor): string | null {
  return actor.type === 'USER' ? actor.userId : null;
}
