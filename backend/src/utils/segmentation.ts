/**
 * SMS encoding detection and segmentation (3GPP TS 23.038). Pure functions: the per-segment
 * limits are business configuration and are passed in (see sms/segmentation.service.ts, which
 * loads the active, versioned configuration). Nothing here decides prices or limits.
 *
 * Limits are measured in *encoding units*, which is what networks bill:
 *  - GSM-7: septets. Basic-table characters cost 1; extension-table characters (€ [ ] { } ^ ~ | \ and
 *    form feed) cost 2 (escape + char), and an escape pair is never split across two parts.
 *  - UCS-2: UTF-16 code units. Characters outside the Basic Multilingual Plane (most emoji) are
 *    surrogate pairs costing 2, and a pair is never split across parts. Combining marks are their
 *    own code points and cost 1 each.
 * For ordinary text one character = one unit. `characterCount` reports user-perceived characters
 * (grapheme clusters), so "👍🏽" is 1 character but 4 UCS-2 units.
 */

const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXTENDED = '\f^{}\\[~]|€';

const basicSet = new Set(Array.from(GSM7_BASIC));
const extSet = new Set(Array.from(GSM7_EXTENDED));

export type SmsEncodingName = 'GSM7' | 'UCS2';

/** Units per segment for each encoding: `single` for a one-part message, `multi` per part of a longer one. */
export interface SegmentationRules {
  gsm7SingleSegment: number;
  gsm7MultiSegment: number;
  ucs2SingleSegment: number;
  ucs2MultiSegment: number;
}

export interface SegmentInfo {
  encoding: SmsEncodingName;
  /** User-perceived characters (grapheme clusters). */
  characterCount: number;
  /** Septets (GSM-7) or UTF-16 code units (UCS-2) consumed. */
  units: number;
  segments: number;
  /** Limits that applied, so callers can store/show them. */
  charactersPerSingleSegment: number;
  charactersPerMultipartSegment: number;
  /** Units available per segment for this message. */
  perSegment: number;
  /** Units left before another segment is needed. */
  remainingInSegment: number;
}

const graphemes = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/** User-perceived character count (falls back to code points where Intl.Segmenter is unavailable). */
export function countCharacters(text: string): number {
  if (!graphemes) return Array.from(text).length;
  let n = 0;
  for (const _ of graphemes.segment(text)) n++;
  return n;
}

export function isGsm7(text: string): boolean {
  for (const ch of text) {
    if (!basicSet.has(ch) && !extSet.has(ch)) return false;
  }
  return true;
}

/** Cost of each code point in the chosen encoding. */
function unitCosts(text: string, encoding: SmsEncodingName): number[] {
  return Array.from(text).map((c) => (encoding === 'GSM7' ? (extSet.has(c) ? 2 : 1) : c.length));
}

/**
 * Pack units into parts. Equivalent to ceil(units / multi) except that a 2-unit character is moved
 * whole to the next part instead of being split, exactly as handsets and SMSCs do.
 */
function packParts(costs: number[], single: number, multi: number): { units: number; segments: number } {
  const units = costs.reduce((a, b) => a + b, 0);
  if (units === 0) return { units: 0, segments: 0 };
  if (units <= single) return { units, segments: 1 };
  let segments = 1;
  let used = 0;
  for (const c of costs) {
    if (used + c > multi) {
      segments += 1;
      used = 0;
    }
    used += c;
  }
  return { units, segments };
}

export function calculateSegments(text: string, rules: SegmentationRules): SegmentInfo {
  const encoding: SmsEncodingName = isGsm7(text) ? 'GSM7' : 'UCS2';
  const single = encoding === 'GSM7' ? rules.gsm7SingleSegment : rules.ucs2SingleSegment;
  const multi = encoding === 'GSM7' ? rules.gsm7MultiSegment : rules.ucs2MultiSegment;
  const { units, segments } = packParts(unitCosts(text, encoding), single, multi);
  const capacity = segments <= 1 ? single : segments * multi;
  return {
    encoding,
    characterCount: countCharacters(text),
    units,
    segments,
    charactersPerSingleSegment: single,
    charactersPerMultipartSegment: multi,
    perSegment: segments <= 1 ? single : multi,
    remainingInSegment: Math.max(0, capacity - units),
  };
}
