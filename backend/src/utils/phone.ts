/**
 * Phone number normalisation to E.164.
 * Accepts "+250 788 123 456", "00250788123456", "250788123456" and national
 * format "0788123456" (using the configured default country calling code).
 */
const E164 = /^\+[1-9]\d{7,14}$/;

export function normalizePhone(input: string, defaultCountryCode = '250'): string | null {
  if (!input) return null;
  let s = String(input).trim().replace(/[\s\-().]/g, '');
  if (!s) return null;
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (!s.startsWith('+')) {
    if (!/^\d+$/.test(s)) return null;
    if (s.startsWith('0')) s = `+${defaultCountryCode}${s.slice(1)}`;
    else if (s.startsWith(defaultCountryCode)) s = `+${s}`;
    else s = `+${s}`;
  }
  return E164.test(s) ? s : null;
}

export function isValidE164(phone: string): boolean {
  return E164.test(phone);
}

export function maskPhone(phone: string): string {
  if (phone.length < 7) return phone;
  return `${phone.slice(0, 5)}****${phone.slice(-3)}`;
}
