import multer from 'multer';
import { env } from '../config/env';
import { AppError } from '../utils/errors';

/**
 * Uploads are buffered in memory (bounded by UPLOAD_MAX_BYTES), validated by magic bytes,
 * then written by the storage service under a random name. Client file names are never
 * used as paths.
 */
export const ALLOWED_DOCUMENT_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

export const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.UPLOAD_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_DOCUMENT_TYPES[file.mimetype]) {
      return cb(AppError.badRequest('Only PDF, PNG and JPEG files are allowed', 'INVALID_FILE_TYPE'));
    }
    cb(null, true);
  },
});

export const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const okName = /\.csv$/i.test(file.originalname);
    const okType = ['text/csv', 'application/vnd.ms-excel', 'text/plain', 'application/octet-stream'].includes(file.mimetype);
    if (!okName || !okType) return cb(AppError.badRequest('Please upload a .csv file', 'INVALID_FILE_TYPE'));
    cb(null, true);
  },
});

/** Verify the file content matches the declared type (defends against renamed executables). */
export function detectFileType(buf: Buffer): string | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return null;
}
