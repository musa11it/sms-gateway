import crypto from 'crypto';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import { uploadRoot } from '../config/env';

/**
 * Local private file storage. Files are stored under random names; callers only ever see
 * an opaque storage key. Swap for S3/GCS by keeping the same three functions.
 */
function resolveKey(key: string): string {
  if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(pdf|png|jpg)$/.test(key)) throw new Error('Invalid storage key');
  const full = path.resolve(uploadRoot, key);
  if (!full.startsWith(path.resolve(uploadRoot) + path.sep)) throw new Error('Path traversal blocked');
  return full;
}

export async function saveFile(organizationId: string, buffer: Buffer, ext: string) {
  const key = `${organizationId}/${crypto.randomUUID()}.${ext}`;
  const full = resolveKey(key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, buffer, { flag: 'wx' });
  return { storageKey: key, checksum: crypto.createHash('sha256').update(buffer).digest('hex') };
}

export function openFile(key: string) {
  return createReadStream(resolveKey(key));
}

export async function deleteFile(key: string) {
  await fs.rm(resolveKey(key), { force: true });
}
