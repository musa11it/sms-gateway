import { getCountries, getCountryCallingCode, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';
import type { Destination, RoutingContext } from './routing.service';

/**
 * Destination check — the first step of routing, shared by dashboard sends, campaigns, the
 * public API and the routing simulator:
 *
 *   1. Validate the complete number against the country's numbering plan (libphonenumber metadata):
 *      calling code, length and number ranges — not just a prefix.
 *   2. Identify the country and require it to be configured and active (database).
 *   3. Apply the country's/network's extra length rules, if any.
 *   4. Identify the network by the longest matching E.164 prefix among the country's active networks.
 *
 * Whether a provider can serve the result is decided afterwards by the routing engine.
 */

export type DestinationErrorCode = 'INVALID_NUMBER' | 'UNSUPPORTED_COUNTRY';

export type DestinationCheck =
  | ({ ok: true; phone: string; countryName: string; nationalNumber: string } & Destination)
  | { ok: false; phone: string; code: DestinationErrorCode; reason: string; countryCode: string | null };

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

/** English country name for an ISO code (numbering-plan independent). */
export function countryName(isoCode: string): string {
  try {
    return regionNames.of(isoCode) ?? isoCode;
  } catch {
    return isoCode;
  }
}

/** Calling code (digits, no "+") for an ISO code, or null if the numbering-plan data does not know it. */
export function callingCodeFor(isoCode: string): string | null {
  return (getCountries() as string[]).includes(isoCode) ? getCountryCallingCode(isoCode as CountryCode) : null;
}

export function isKnownCountry(isoCode: string) {
  return callingCodeFor(isoCode) !== null;
}

function lengths(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n)) : [];
}

export function checkDestination(ctx: RoutingContext, phone: string): DestinationCheck {
  const parsed = parsePhoneNumberFromString(phone);
  if (!parsed) return { ok: false, phone, code: 'INVALID_NUMBER', reason: 'Invalid destination number: not a valid international number', countryCode: null };
  const iso = parsed.country ?? null;
  const e164 = parsed.number;
  const configured = iso ? ctx.countries.find((c) => c.isoCode === iso) : undefined;
  const name = iso ? (configured?.name ?? countryName(iso)) : null;

  // 1. Numbering plan: complete number, not just the calling code.
  const strict = (configured?.validationMode ?? 'STRICT') === 'STRICT';
  const planOk = strict ? parsed.isValid() : parsed.isPossible();
  if (!iso || !planOk) {
    const where = name ?? (parsed.countryCallingCode ? `+${parsed.countryCallingCode}` : 'any country');
    return { ok: false, phone: e164, code: 'INVALID_NUMBER', reason: `Invalid destination number: invalid length/format for ${where}`, countryCode: iso };
  }

  // 2. Country must be configured and active.
  if (!configured || !configured.isActive) {
    return { ok: false, phone: e164, code: 'UNSUPPORTED_COUNTRY', reason: `Destination not supported: ${name} (${iso}) is not configured for sending`, countryCode: iso };
  }

  // 3. Network by longest prefix within the country.
  let network: RoutingContext['networks'][number] | null = null;
  let best = 0;
  for (const n of ctx.networks) {
    if (n.countryCode !== iso) continue;
    for (const p of n.prefixList) {
      if (e164.startsWith(p) && p.length > best) {
        network = n;
        best = p.length;
      }
    }
  }

  // 4. Extra length rules (network rule overrides the country rule).
  const rule = lengths(network?.nationalNumberLengths).length ? lengths(network?.nationalNumberLengths) : lengths(configured.nationalNumberLengths);
  if (rule.length && !rule.includes(parsed.nationalNumber.length)) {
    return {
      ok: false,
      phone: e164,
      code: 'INVALID_NUMBER',
      reason: `Invalid destination number: ${network ? network.name : name} numbers have ${rule.join(' or ')} digits after +${parsed.countryCallingCode}`,
      countryCode: iso,
    };
  }

  return { ok: true, phone: e164, countryCode: iso, countryName: configured.name, network, nationalNumber: parsed.nationalNumber };
}

/** The destination used when only a country/network is known (simulator, previews). */
export function destinationFor(ctx: RoutingContext, input: { networkId?: string | null; countryCode?: string | null }): Destination {
  const network = input.networkId ? (ctx.networks.find((n) => n.id === input.networkId) ?? null) : null;
  return { network, countryCode: network?.countryCode ?? input.countryCode ?? null };
}
