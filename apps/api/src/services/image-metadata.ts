/**
 * Removes location/camera metadata from homework images before any processing (spec P4: "Strip EXIF
 * and location metadata"; AC_CAPTURE_02 content validation). Dependency-free and Workers-safe: it
 * walks the container structure and copies only the segments/chunks needed to render the image.
 *
 * JPEG: an ALLOW-list too: keeps SOI, the segments a decoder needs (frame headers SOFn, DHT, DAC,
 *       DQT, DRI, DNL, DHP, EXP, SOS with its scan data, RSTn, TEM, EOI), one JFIF header rewritten
 *       to its fixed 14 bytes (version, units, density; no thumbnail, no trailing bytes) and APP2
 *       segments that are ICC colour profiles. Everything else is dropped: APP1 (Exif, GPS, XMP),
 *       APP0 JFXX thumbnails and non-JFIF APP0, APP2 FlashPix/MPF, APP3–APP15, COM, the reserved
 *       JPG/JPGn and low markers, and any bytes after EOI (RV-lead-jobs-ai-16).
 * PNG:  an ALLOW-list: keeps only the critical chunks (IHDR, PLTE, IDAT, IEND) and the rendering
 *       chunks that change how pixels look (tRNS, gAMA, cHRM, sRGB, iCCP, sBIT, pHYs, bKGD). Every
 *       other chunk is dropped — text (tEXt/zTXt/iTXt), Exif (eXIf and the pre-standard exIf), time,
 *       C2PA/JUMBF provenance (caBX, which can carry exif:GPS assertions) and any unknown or vendor
 *       chunk, so a new metadata carrier can never pass through by default (RV-lead-jobs-ai-16).
 *       APNG animation chunks are dropped too; the first frame (IDAT) still renders.
 *
 * Anything that does not parse as the declared type is rejected (never passed through "as is").
 */

export class ImageFormatError extends Error {
  constructor(readonly code: 'SIGNATURE_MISMATCH' | 'MALFORMED' | 'UNSUPPORTED_TYPE') {
    super(code);
    this.name = 'ImageFormatError';
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_KEEP: ReadonlySet<string> = new Set([
  'IHDR',
  'PLTE',
  'IDAT',
  'IEND',
  'tRNS',
  'gAMA',
  'cHRM',
  'sRGB',
  'iCCP',
  'sBIT',
  'pHYs',
  'bKGD',
]);

export function stripImageMetadata(bytes: Uint8Array, mimeType: string): Uint8Array {
  if (mimeType === 'image/jpeg') return stripJpeg(bytes);
  if (mimeType === 'image/png') return stripPng(bytes);
  throw new ImageFormatError('UNSUPPORTED_TYPE');
}

/** Segments a decoder needs besides SOS: DHT, DAC, DQT, DNL, DRI, DHP, EXP. */
const JPEG_TABLES: ReadonlySet<number> = new Set([0xc4, 0xcc, 0xdb, 0xdc, 0xdd, 0xde, 0xdf]);
const JFIF_ID = [0x4a, 0x46, 0x49, 0x46, 0x00]; // "JFIF\0"
const ICC_ID = Array.from('ICC_PROFILE\0', (c) => c.charCodeAt(0));

/** Frame headers SOF0–SOF15 (0xC0–0xCF without DHT 0xC4, JPG 0xC8 and DAC 0xCC). */
function isFrameHeader(marker: number): boolean {
  return (
    marker >= 0xc0 && marker <= 0xcf && !(marker === 0xc4 || marker === 0xc8 || marker === 0xcc)
  );
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((b, k) => bytes[k] === b);
}

/**
 * The JFIF header with only the fields that affect rendering or physical size: version, density
 * units and density. The optional thumbnail and anything after the fixed fields are dropped.
 */
function canonicalJfif(payload: Uint8Array): Uint8Array {
  const minor = Math.min(payload[6] ?? 1, 2);
  const units = (payload[7] ?? 0) <= 2 ? (payload[7] ?? 0) : 0;
  const density = (hi: number | undefined, lo: number | undefined) => {
    const value = ((hi ?? 0) << 8) | (lo ?? 0);
    return value === 0 ? [0, 1] : [value >> 8, value & 0xff];
  };
  return new Uint8Array([
    0xff,
    0xe0,
    0x00,
    0x10,
    ...JFIF_ID,
    0x01,
    minor,
    units,
    ...density(payload[8], payload[9]),
    ...density(payload[10], payload[11]),
    0x00,
    0x00,
  ]);
}

function stripJpeg(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    throw new ImageFormatError('SIGNATURE_MISMATCH');
  }
  const kept: Uint8Array[] = [bytes.subarray(0, 2)];
  let sawJfif = false;
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) throw new ImageFormatError('MALFORMED');
    // Fill bytes (0xFF padding) may precede a marker.
    let m = i + 1;
    while (m < bytes.length && bytes[m] === 0xff) m += 1;
    if (m >= bytes.length) throw new ImageFormatError('MALFORMED');
    const marker = bytes[m]!;
    if (marker === 0xd9) {
      kept.push(bytes.subarray(m - 1, m + 1)); // EOI; anything after it is dropped
      return concat(kept);
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      kept.push(bytes.subarray(m - 1, m + 1)); // standalone markers (TEM, RSTn)
      i = m + 1;
      continue;
    }
    if (m + 2 >= bytes.length) throw new ImageFormatError('MALFORMED');
    const length = (bytes[m + 1]! << 8) | bytes[m + 2]!;
    if (length < 2 || m + 1 + length > bytes.length) throw new ImageFormatError('MALFORMED');
    const segmentEnd = m + 1 + length;
    const payload = bytes.subarray(m + 3, segmentEnd);
    if (marker === 0xda) {
      // Start of scan: header, then entropy-coded data up to the next non-RST marker (usually EOI).
      let end = segmentEnd;
      while (end + 1 < bytes.length) {
        if (bytes[end] === 0xff) {
          const next = bytes[end + 1]!;
          if (next !== 0x00 && next !== 0xff && !(next >= 0xd0 && next <= 0xd7)) break;
        }
        end += 1;
      }
      kept.push(bytes.subarray(m - 1, end));
      i = end;
      continue;
    }
    if (isFrameHeader(marker) || JPEG_TABLES.has(marker)) {
      kept.push(bytes.subarray(m - 1, segmentEnd));
    } else if (marker === 0xe0 && !sawJfif && startsWith(payload, JFIF_ID)) {
      kept.push(canonicalJfif(payload));
      sawJfif = true;
    } else if (marker === 0xe2 && startsWith(payload, ICC_ID)) {
      kept.push(bytes.subarray(m - 1, segmentEnd));
    }
    // Everything else is dropped.
    i = segmentEnd;
  }
  throw new ImageFormatError('MALFORMED'); // no EOI
}

function stripPng(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 8 || PNG_SIGNATURE.some((b, k) => bytes[k] !== b)) {
    throw new ImageFormatError('SIGNATURE_MISMATCH');
  }
  const kept: Uint8Array[] = [bytes.subarray(0, 8)];
  let i = 8;
  let sawEnd = false;
  while (i < bytes.length) {
    if (i + 12 > bytes.length) throw new ImageFormatError('MALFORMED');
    const length =
      ((bytes[i]! << 24) >>> 0) + (bytes[i + 1]! << 16) + (bytes[i + 2]! << 8) + bytes[i + 3]!;
    const end = i + 12 + length;
    if (end > bytes.length) throw new ImageFormatError('MALFORMED');
    const type = String.fromCharCode(bytes[i + 4]!, bytes[i + 5]!, bytes[i + 6]!, bytes[i + 7]!);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new ImageFormatError('MALFORMED');
    if (PNG_KEEP.has(type)) kept.push(bytes.subarray(i, end));
    i = end;
    if (type === 'IEND') {
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd) throw new ImageFormatError('MALFORMED');
  return concat(kept);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
