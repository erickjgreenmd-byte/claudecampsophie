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

  it('PNG is an allow-list: rendering chunks survive, every other chunk is dropped (RV-lead-jobs-ai-16)', () => {
    const rendering = ['PLTE', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'pHYs', 'bKGD'];
    // Metadata carriers a deny-list misses: pre-standard Exif, C2PA/JUMBF, time, APNG control,
    // vendor/private chunks and an unknown future ancillary chunk.
    const dropped = ['exIf', 'caBX', 'tIME', 'acTL', 'fcTL', 'vpAg', 'prVt', 'zzZz'];
    const input = new Uint8Array([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      ...chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 3, 0, 0, 0]),
      ...rendering.flatMap((type) => chunk(type, ascii(`keep-${type}`))),
      ...dropped.flatMap((type) => chunk(type, ascii(`GPSLatitude-${type}`))),
      ...chunk('IDAT', [1, 2, 3]),
      ...chunk('IEND', []),
    ]);
    const out = stripImageMetadata(input, 'image/png');
    for (const type of ['IHDR', 'IDAT', 'IEND', ...rendering]) {
      expect(hasBytes(out, type), type).toBe(true);
    }
    for (const type of rendering) expect(hasBytes(out, `keep-${type}`), type).toBe(true);
    expect(hasBytes(out, 'GPSLatitude')).toBe(false);
    for (const type of dropped) expect(hasBytes(out, type), type).toBe(false);
    // Idempotent, and the output is still a well-formed PNG.
    expect(stripImageMetadata(out, 'image/png')).toEqual(out);
  });

  it('JPEG is an allow-list too: only decoding segments, a bare JFIF header and ICC profiles survive (RV-lead-jobs-ai-16)', () => {
    const jfif = [
      ...ascii('JFIF\0'),
      1,
      2, // version 1.02
      1, // units: dots per inch
      0,
      72,
      0,
      72, // density
      2,
      1, // a 2x1 RGB thumbnail follows ...
      ...ascii('THUMB!'),
      ...ascii('GPSThumbTrailer'), // ... and bytes no decoder reads
    ];
    const input = new Uint8Array([
      0xff,
      0xd8,
      ...segment(0xe0, jfif),
      ...segment(0xe0, [...ascii('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0, ...ascii('GPSDup')]), // 2nd
      ...segment(0xe0, ascii('JFXX\0\x10GPSLongitude=-122.4')), // JFIF extension thumbnail
      ...segment(0xe2, ascii('FPXR\0GPSLatitude=37.7749')), // FlashPix, not a colour profile
      ...segment(0xe2, ascii('MPF\0MM\0*GPSSecondImage')), // multi-picture index
      ...segment(0xe2, ascii('ICC_PROFILE\0\x01\x01profile-bytes')),
      ...segment(0xee, ascii('Adobe\0GPSAdobe')), // APP14
      ...segment(0xf7, ascii('GPSAltitude=12')), // reserved JPGn marker
      ...segment(0xc8, ascii('GPSReservedJPG')), // reserved JPG marker
      ...segment(0x4f, ascii('GPSReservedLow')), // reserved low marker
      ...segment(0xdb, [0x00, ...new Array<number>(64).fill(1)]),
      ...segment(0xc4, [0x00, ...new Array<number>(16).fill(0)]), // DHT
      ...segment(0xdd, [0x00, 0x04]), // DRI
      ...segment(0xc0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]),
      ...segment(0xda, [1, 1, 0, 0, 0x3f, 0]),
      0x12,
      0xff,
      0x00,
      0x34,
      0xff,
      0xd9,
      ...ascii('GPSAfterEOI'),
    ]);
    const out = stripImageMetadata(input, 'image/jpeg');
    expect(hasBytes(out, 'GPS')).toBe(false);
    for (const gone of ['JFXX', 'FPXR', 'MPF', 'Adobe', 'THUMB!']) {
      expect(hasBytes(out, gone), gone).toBe(false);
    }
    expect(hasBytes(out, 'ICC_PROFILE\0\x01\x01profile-bytes')).toBe(true);
    // The JFIF header keeps its version, units and density; the thumbnail is removed.
    expect(hasBytes(out, '\xff\xe0\x00\x10JFIF\0\x01\x02\x01\x00\x48\x00\x48\x00\x00')).toBe(true);
    expect(out.filter((b, k) => b === 0xff && out[k + 1] === 0xe0)).toHaveLength(1); // one header
    // Tables, frame and scan survive byte for byte.
    for (const marker of [0xdb, 0xc4, 0xdd, 0xc0, 0xda]) {
      expect(hasBytes(out, String.fromCharCode(0xff, marker)), marker.toString(16)).toBe(true);
    }
    expect(hasBytes(out, '\x12\xff\x00\x34\xff\xd9')).toBe(true);
    expect(Array.from(out.slice(-2))).toEqual([0xff, 0xd9]);
    expect(stripImageMetadata(out, 'image/jpeg')).toEqual(out); // idempotent
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
