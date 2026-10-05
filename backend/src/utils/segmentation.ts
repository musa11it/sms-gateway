/**
 * SMS segmentation (3GPP TS 23.038).
 *
 * GSM-7: 160 septets single / 153 per part when concatenated (UDH takes 7 septets).
 *        Extension-table characters (e.g. € [ ] { }) cost 2 septets and an escape
 *        sequence is never split across two parts.
 * UCS-2: 70 code units single / 67 per part. Surrogate pairs (emoji) cost 2 units
 *        and are never split across parts.
 */

const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXTENDED = '\f^{}\\[~]|€';

const basicSet = new Set(Array.from(GSM7_BASIC));
const extSet = new Set(Array.from(GSM7_EXTENDED));

export type SmsEncodingName = 'GSM7' | 'UCS2';

export interface SegmentInfo {
  encoding: SmsEncodingName;
  /** Visible characters (Unicode code points). */
  characterCount: number;
  /** Septets (GSM7) or UTF-16 code units (UCS2) consumed. */
  units: number;
  segments: number;
  /** Units available per segment for this message. */
  perSegment: number;
  /** Units left before another segment is needed. */
  remainingInSegment: number;
}

export function isGsm7(text: string): boolean {
  for (const ch of text) {
    if (!basicSet.has(ch) && !extSet.has(ch)) return false;
  }
  return true;
}

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

export function calculateSegments(text: string): SegmentInfo {
  const chars = Array.from(text);
  const gsm = isGsm7(text);
  const costs = gsm ? chars.map((c) => (extSet.has(c) ? 2 : 1)) : chars.map((c) => (c.length > 1 ? 2 : 1));
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  const { units, segments } = packParts(costs, single, multi);
  const perSegment = segments <= 1 ? single : multi;
  const capacity = segments <= 1 ? single : segments * multi;
  return {
    encoding: gsm ? 'GSM7' : 'UCS2',
    characterCount: chars.length,
    units,
    segments,
    perSegment,
    remainingInSegment: Math.max(0, capacity - units),
  };
}
