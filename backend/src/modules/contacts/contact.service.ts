import { prisma } from '../../config/prisma';
import { AppError } from '../../utils/errors';
import { normalizePhone } from '../../utils/phone';
import { getSetting } from '../settings/settings.service';
import type { RecipientInput } from '../sms/sms.service';

/** Expand groups/contacts/raw numbers into a recipient list (active contacts only). */
export async function resolveAudience(
  organizationId: string,
  input: { groupIds?: string[]; contactIds?: string[]; phones?: string[] },
): Promise<RecipientInput[]> {
  const out: RecipientInput[] = [];
  if (input.groupIds?.length) {
    const groups = await prisma.contactGroup.findMany({ where: { organizationId, id: { in: input.groupIds } }, select: { id: true } });
    if (groups.length !== new Set(input.groupIds).size) throw AppError.unprocessable('One or more groups were not found', 'GROUP_NOT_FOUND');
    const members = await prisma.contact.findMany({
      where: { organizationId, status: 'ACTIVE', groups: { some: { groupId: { in: input.groupIds } } } },
      select: { id: true, phone: true },
    });
    out.push(...members.map((c) => ({ phone: c.phone, contactId: c.id })));
  }
  if (input.contactIds?.length) {
    const contacts = await prisma.contact.findMany({ where: { organizationId, id: { in: input.contactIds }, status: 'ACTIVE' }, select: { id: true, phone: true } });
    out.push(...contacts.map((c) => ({ phone: c.phone, contactId: c.id })));
  }
  if (input.phones?.length) out.push(...input.phones.map((p) => ({ phone: p })));
  return out;
}

// ── CSV import ──────────────────────────────────────────────────────────

/** Minimal RFC 4180 parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

export type ImportRowStatus = 'valid' | 'invalid' | 'duplicate' | 'missing' | 'existing';

export interface ImportRow {
  line: number;
  name: string | null;
  phone: string | null;
  rawPhone: string;
  email: string | null;
  tags: string[];
  status: ImportRowStatus;
  reason?: string;
}

const MAX_IMPORT_ROWS = 20_000;
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function analyzeCsv(organizationId: string, text: string) {
  const rows = parseCsv(text);
  if (rows.length === 0) throw AppError.unprocessable('The file is empty', 'EMPTY_FILE');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const phoneIdx = header.findIndex((h) => ['phone', 'phone number', 'mobile', 'msisdn', 'number'].includes(h));
  if (phoneIdx === -1) throw AppError.unprocessable('The CSV must have a "phone" column header', 'MISSING_PHONE_COLUMN');
  const nameIdx = header.findIndex((h) => ['name', 'full name', 'fullname'].includes(h));
  const emailIdx = header.indexOf('email');
  const tagsIdx = header.indexOf('tags');
  const data = rows.slice(1);
  if (data.length > MAX_IMPORT_ROWS) throw AppError.unprocessable(`At most ${MAX_IMPORT_ROWS.toLocaleString()} rows per import`, 'TOO_MANY_ROWS');

  const cc = await getSetting('sms.defaultCountryCode');
  const seen = new Set<string>();
  const result: ImportRow[] = data.map((cols, i) => {
    const rawPhone = (cols[phoneIdx] ?? '').trim();
    const name = nameIdx >= 0 ? (cols[nameIdx] ?? '').trim().slice(0, 120) || null : null;
    const emailRaw = emailIdx >= 0 ? (cols[emailIdx] ?? '').trim() : '';
    const tags = tagsIdx >= 0 ? (cols[tagsIdx] ?? '').split(/[;|]/).map((t) => t.trim()).filter(Boolean).slice(0, 10) : [];
    const base = { line: i + 2, name, rawPhone, email: null as string | null, tags };
    if (!rawPhone) return { ...base, phone: null, status: 'missing' as const, reason: 'Phone number is missing' };
    const phone = normalizePhone(rawPhone, cc);
    if (!phone) return { ...base, phone: null, status: 'invalid' as const, reason: 'Invalid phone number' };
    if (emailRaw && !emailRe.test(emailRaw)) return { ...base, phone, status: 'invalid' as const, reason: 'Invalid email address' };
    if (seen.has(phone)) return { ...base, phone, email: emailRaw || null, status: 'duplicate' as const, reason: 'Duplicate within file' };
    seen.add(phone);
    return { ...base, phone, email: emailRaw || null, status: 'valid' as const };
  });

  const phones = result.filter((r) => r.status === 'valid').map((r) => r.phone!);
  const existing = new Set(
    phones.length
      ? (await prisma.contact.findMany({ where: { organizationId, phone: { in: phones } }, select: { phone: true } })).map((c) => c.phone)
      : [],
  );
  for (const r of result) {
    if (r.status === 'valid' && existing.has(r.phone!)) {
      r.status = 'existing';
      r.reason = 'Already in your contacts';
    }
  }
  const summary = { total: result.length, valid: 0, invalid: 0, duplicate: 0, missing: 0, existing: 0 };
  for (const r of result) summary[r.status] += 1;
  return { summary, rows: result };
}
