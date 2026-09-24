import { describe, expect, it } from 'vitest';
import { ImageFormatError, stripImageMetadata } from '../src/services/image-metadata.ts';

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const segment = (marker: number, payload: number[]) => {
  const length = payload.length + 2;
  return [0xff, marker, length >> 8, length & 0xff, ...payload];
};

/** Structurally valid synthetic JPEG: JFIF, Exif with a GPS tag, XMP, comment, tables, scan. */
function jpeg(): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    ...segment(0xe0, ascii('JFIF\0\x01\x02')),
    ...segment(0xe1, ascii('Exif\0\0GPSLatitude=51.5')),
    ...segment(0xe1, ascii('http://ns.adobe.com/xap/1.0/\0<x:gps/>')),
    ...segment(0xe2, ascii('ICC_PROFILE\0')),
    ...segment(0xed, ascii('Photoshop 3.0\0IPTC-city')),
    ...segment(0xfe, ascii('camera: Riley phone')),
    ...segment(0xdb, [0x00, ...new Array<number>(64).fill(1)]),
    ...segment(0xc0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]),
    ...segment(0xda, [1, 1, 0, 0, 0x3f, 0]),
    0x12,
    0xff,
    0x00,
    0x34,
    0xff,
    0xd0,
    0x56, // entropy data with stuffing and a restart marker
    0xff,
    0xd9,
  ]);
}

function hasBytes(haystack: Uint8Array, needle: string): boolean {
  const n = ascii(needle);
  outer: for (let i = 0; i + n.length <= haystack.length; i++) {
    for (let k = 0; k < n.length; k++) if (haystack[i + k] !== n[k]) continue outer;
    return true;
  }
  return false;
}

function crc32(bytes: number[]): number {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: number[]): number[] {
  const body = [...ascii(type), ...data];
  const crc = crc32(body);
  const len = data.length;
  return [
    len >>> 24,
    (len >> 16) & 255,
    (len >> 8) & 255,
    len & 255,
    ...body,
    crc >>> 24,
    (crc >> 16) & 255,
    (crc >> 8) & 255,
    crc & 255,
  ];
}

function png(): Uint8Array {
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]),
    ...chunk('tEXt', ascii('Location\0Springfield')),
    ...chunk('eXIf', ascii('GPS')),
    ...chunk('IDAT', [1, 2, 3]),
    ...chunk('IEND', []),
  ]);
}

describe('image metadata stripping (spec P4, AC_CAPTURE_02)', () => {
  it('removes Exif/GPS, XMP, IPTC and comments from JPEG but keeps the image data', () => {
    const out = stripImageMetadata(jpeg(), 'image/jpeg');
    for (const leak of ['Exif', 'GPSLatitude', 'xap/1.0', 'IPTC', 'Riley phone']) {
      expect(hasBytes(out, leak), leak).toBe(false);
    }
    expect(hasBytes(out, 'JFIF')).toBe(true);
    expect(hasBytes(out, 'ICC_PROFILE')).toBe(true);
    expect(Array.from(out.slice(0, 2))).toEqual([0xff, 0xd8]);
    expect(Array.from(out.slice(-2))).toEqual([0xff, 0xd9]);
    // Scan data survives byte for byte, including stuffing and restart markers.
    expect(hasBytes(out, '\x12\xff\x00\x34\xff\xd0\x56')).toBe(true);
    // Idempotent.
    expect(stripImageMetadata(out, 'image/jpeg')).toEqual(out);
  });

  it('removes text, Exif and time chunks from PNG', () => {
    const out = stripImageMetadata(png(), 'image/png');
    expect(hasBytes(out, 'Springfield')).toBe(false);
    expect(hasBytes(out, 'eXIf')).toBe(false);
    expect(hasBytes(out, 'IHDR')).toBe(true);
    expect(hasBytes(out, 'IDAT')).toBe(true);
    expect(hasBytes(out, 'IEND')).toBe(true);
  });

  it('rejects content that is not what it claims to be, or is truncated', () => {
    const bad = (bytes: Uint8Array, mime: string) => () => stripImageMetadata(bytes, mime);
    expect(bad(png(), 'image/jpeg')).toThrow(ImageFormatError);
    expect(bad(jpeg(), 'image/png')).toThrow(ImageFormatError);
    expect(bad(jpeg().slice(0, 40), 'image/jpeg')).toThrow(ImageFormatError);
    expect(bad(png().slice(0, 30), 'image/png')).toThrow(ImageFormatError);
    expect(bad(new Uint8Array([0x25, 0x50, 0x44, 0x46]), 'application/pdf')).toThrow(
      ImageFormatError,
    );
  });
});
