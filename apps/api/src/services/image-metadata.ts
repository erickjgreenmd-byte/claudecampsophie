/**
 * Removes location/camera metadata from homework images before any processing (spec P4: "Strip EXIF
 * and location metadata"; AC_CAPTURE_02 content validation). Dependency-free and Workers-safe: it
 * walks the container structure and copies only the segments/chunks needed to render the image.
 *
 * JPEG: keeps SOI, APP0 (JFIF), APP2 (ICC colour profile), and every non-APP marker (tables, frame,
 *       scan data). Drops APP1 (Exif, GPS, XMP), APP3–APP15 (vendor/IPTC/Photoshop) and COM.
 * PNG:  keeps critical and rendering chunks; drops tEXt, zTXt, iTXt, eXIf and tIME.
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
const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

export function stripImageMetadata(bytes: Uint8Array, mimeType: string): Uint8Array {
  if (mimeType === 'image/jpeg') return stripJpeg(bytes);
  if (mimeType === 'image/png') return stripPng(bytes);
  throw new ImageFormatError('UNSUPPORTED_TYPE');
}

function stripJpeg(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    throw new ImageFormatError('SIGNATURE_MISMATCH');
  }
  const kept: Uint8Array[] = [bytes.subarray(0, 2)];
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) throw new ImageFormatError('MALFORMED');
    // Fill bytes (0xFF padding) may precede a marker.
    let m = i + 1;
    while (m < bytes.length && bytes[m] === 0xff) m += 1;
    if (m >= bytes.length) throw new ImageFormatError('MALFORMED');
    const marker = bytes[m]!;
    if (marker === 0xd9) {
      kept.push(bytes.subarray(m - 1, m + 1)); // EOI
      return concat(kept);
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      kept.push(bytes.subarray(m - 1, m + 1)); // standalone markers
      i = m + 1;
      continue;
    }
    if (m + 2 >= bytes.length) throw new ImageFormatError('MALFORMED');
    const length = (bytes[m + 1]! << 8) | bytes[m + 2]!;
    if (length < 2 || m + 1 + length > bytes.length) throw new ImageFormatError('MALFORMED');
    const segmentEnd = m + 1 + length;
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
    const drop = (marker >= 0xe1 && marker <= 0xef && marker !== 0xe2) || marker === 0xfe;
    if (!drop) kept.push(bytes.subarray(m - 1, segmentEnd));
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
    if (!PNG_DROP.has(type)) kept.push(bytes.subarray(i, end));
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
