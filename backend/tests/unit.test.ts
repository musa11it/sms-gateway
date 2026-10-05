import { describe, expect, it } from 'vitest';
import { signPayload, verifySignature, encrypt, decrypt } from '../src/utils/crypto';
import { normalizePhone } from '../src/utils/phone';
import { calculateSegments } from '../src/utils/segmentation';

/** The default (version 1) rules; the function itself has no built-in limits. */
const RULES = { gsm7SingleSegment: 160, gsm7MultiSegment: 153, ucs2SingleSegment: 70, ucs2MultiSegment: 67 };
import { parseCsv } from '../src/modules/contacts/contact.service';

describe('SMS segmentation', () => {
  it('single GSM-7 message up to 160 chars', () => {
    expect(calculateSegments('a'.repeat(160), RULES)).toMatchObject({ encoding: 'GSM7', segments: 1, characterCount: 160 });
  });
  it('concatenated GSM-7 uses 153 chars per part', () => {
    expect(calculateSegments('a'.repeat(161), RULES).segments).toBe(2);
    expect(calculateSegments('a'.repeat(306), RULES).segments).toBe(2);
    expect(calculateSegments('a'.repeat(307), RULES).segments).toBe(3);
  });
  it('extension characters cost two septets', () => {
    const r = calculateSegments('€'.repeat(80), RULES);
    expect(r).toMatchObject({ encoding: 'GSM7', units: 160, segments: 1 });
    expect(calculateSegments('€'.repeat(81), RULES).segments).toBe(2);
  });
  it('never splits an escape sequence across parts', () => {
    // 152 plain chars + "€" (2 septets) = 154 > 153 → the € moves to part 2
    expect(calculateSegments('a'.repeat(152) + '€' + 'a'.repeat(10), RULES).segments).toBe(2);
  });
  it('switches to UCS-2 for non-GSM characters (70 / 67)', () => {
    expect(calculateSegments('Muraho 👋', RULES)).toMatchObject({ encoding: 'UCS2', segments: 1 });
    expect(calculateSegments('ñ'.repeat(70), RULES).encoding).toBe('GSM7');
    expect(calculateSegments('ą'.repeat(70), RULES).segments).toBe(1);
    expect(calculateSegments('ą'.repeat(71), RULES).segments).toBe(2);
    expect(calculateSegments('ą'.repeat(134), RULES).segments).toBe(2);
    expect(calculateSegments('ą'.repeat(135), RULES).segments).toBe(3);
  });
  it('empty message has zero segments', () => {
    expect(calculateSegments('', RULES).segments).toBe(0);
  });
});

describe('phone normalisation', () => {
  it.each([
    ['+250 788 123 456', '+250788123456'],
    ['0788123456', '+250788123456'],
    ['250788123456', '+250788123456'],
    ['00250788123456', '+250788123456'],
    ['(0788) 123-456', '+250788123456'],
  ])('%s → %s', (input, out) => expect(normalizePhone(input)).toBe(out));
  it.each(['abc', '123', '+0123456789', ''])('rejects %s', (input) => expect(normalizePhone(input)).toBeNull());
});

describe('signatures & encryption', () => {
  it('verifies valid signatures and rejects tampering/expired', () => {
    const body = JSON.stringify({ a: 1 });
    const sig = signPayload('secret', body);
    expect(verifySignature('secret', body, sig)).toBe(true);
    expect(verifySignature('secret', body + ' ', sig)).toBe(false);
    expect(verifySignature('other', body, sig)).toBe(false);
    expect(verifySignature('secret', body, signPayload('secret', body, Math.floor(Date.now() / 1000) - 3600))).toBe(false);
  });
  it('round-trips AES-GCM encryption', () => {
    expect(decrypt(encrypt('whsec_abc'))).toBe('whsec_abc');
  });
});

describe('CSV parser', () => {
  it('handles quotes, commas and CRLF', () => {
    expect(parseCsv('name,phone\r\n"Doe, John",+250788123456\r\n"Say ""hi""",0788\n')).toEqual([
      ['name', 'phone'],
      ['Doe, John', '+250788123456'],
      ['Say "hi"', '0788'],
    ]);
  });
});
