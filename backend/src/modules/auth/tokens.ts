import jwt from 'jsonwebtoken';
import { env } from '../../config/env';

export interface AccessTokenPayload {
  sub: string;
  sid: string;
  typ: 'access';
}

export function signAccessToken(userId: string, sessionId: string): string {
  return jwt.sign({ sub: userId, sid: sessionId, typ: 'access' }, env.JWT_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions['expiresIn'],
    issuer: 'sms-gateway',
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload | null {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, { issuer: 'sms-gateway' }) as AccessTokenPayload;
    return payload.typ === 'access' ? payload : null;
  } catch {
    return null;
  }
}

/**
 * Refresh tokens are opaque "<sessionId>.<random>" strings, signed with JWT_REFRESH_SECRET
 * (HMAC) before hashing so a DB leak alone cannot mint valid tokens.
 */
export const REFRESH_COOKIE = 'sgw_rt';
