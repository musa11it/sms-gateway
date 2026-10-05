import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { isTest } from '../../config/env';

const ROUNDS = isTest ? 4 : 12;

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password is too long')
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/\d/, 'Password must contain a number');

/** Strong random password (no look-alike characters) that always satisfies `passwordSchema`. */
export function generatePassword(length = 14): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const symbols = '#$%&*+-=?@';
  const all = letters + digits + symbols;
  const pick = (set: string) => set[crypto.randomInt(set.length)];
  const chars = [pick(letters), pick(letters), pick(digits), pick(digits), pick(symbols), ...Array.from({ length: length - 5 }, () => pick(all))];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

export function hashPassword(password: string) {
  return bcrypt.hash(password, ROUNDS);
}

export function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

// Used to keep login timing uniform when the email does not exist.
export const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', ROUNDS);
