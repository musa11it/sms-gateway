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

export function hashPassword(password: string) {
  return bcrypt.hash(password, ROUNDS);
}

export function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

// Used to keep login timing uniform when the email does not exist.
export const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', ROUNDS);
