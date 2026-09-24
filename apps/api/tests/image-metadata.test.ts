import { describe, expect, it } from 'vitest';
import { HOMEWORK_IMAGE_LIMITS } from '@pencillift/contracts';
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

// ---------------------------------------------------------------------------------------------
// Declared dimensions (AC_CAPTURE_02: "image dimensions are validated"; decompression bombs)
// ---------------------------------------------------------------------------------------------

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n: number) => [(n >> 8) & 255, n & 255];

/** IHDR data: width, height, 8-bit greyscale, no interlace. */
const ihdr = (width: number, height: number) => [...u32(width), ...u32(height), 8, 0, 0, 0, 0];

/** A few dozen bytes that declare `width` × `height` pixels. IDAT is never inflated here. */
function pngOfSize(width: number, height: number, after: number[][] = []): Uint8Array {
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk('IHDR', ihdr(width, height)),
    ...after.flat(),
    ...chunk('IDAT', [1, 2, 3]),
    ...chunk('IEND', []),
  ]);
}

/** Baseline frame header: precision 8, height, width, one component. */
const sof = (width: number, height: number, marker = 0xc0) =>
  segment(marker, [8, ...u16(height), ...u16(width), 1, 1, 0x11, 0]);
const dqt = () => segment(0xdb, [0x00, ...new Array<number>(64).fill(1)]);
const sos = () => [...segment(0xda, [1, 1, 0, 0, 0x3f, 0]), 0x12, 0x34];

function jpegOf(...parts: number[][]): Uint8Array {
  return new Uint8Array([0xff, 0xd8, ...parts.flat(), 0xff, 0xd9]);
}

const jpegOfSize = (width: number, height: number) => jpegOf(dqt(), sof(width, height), sos());

/** The ImageFormatError code, or null when the image is accepted. */
function refusal(bytes: Uint8Array, mime: string): string | null {
  try {
    stripImageMetadata(bytes, mime);
    return null;
  } catch (error) {
    if (error instanceof ImageFormatError) return error.code;
    throw error;
  }
}

describe('declared image dimensions (AC_CAPTURE_02 decompression bombs)', () => {
  it('uses the shared limits from contracts: 10,000 px per side and 60 megapixels', () => {
    expect(HOMEWORK_IMAGE_LIMITS).toEqual({ maxSidePx: 10_000, maxPixels: 60_000_000 });
  });

  it('accepts ordinary photos and images exactly at the limits', () => {
    for (const [w, h] of [
      [1, 1],
      [4032, 3024], // 12 MP phone default
      [8064, 6048], // 48 MP full resolution
      [8192, 6144], // 50 MP full resolution
      [10_000, 6_000], // exactly 60 MP, longest side exactly 10,000
      [6_000, 10_000],
    ] as const) {
      expect(refusal(pngOfSize(w, h), 'image/png'), `png ${w}x${h}`).toBeNull();
      expect(refusal(jpegOfSize(w, h), 'image/jpeg'), `jpeg ${w}x${h}`).toBeNull();
    }
  });

  it('refuses tiny files that declare huge dimensions, with a distinct reason', () => {
    for (const [w, h] of [
      [10_001, 1], // one side too long
      [1, 10_001],
      [10_000, 6_001], // sides fine, 60.01 MP
      [7_746, 7_746], // sides fine, 60.0005 MP
      [65_535, 65_535], // JPEG maximum
    ] as const) {
      expect(refusal(pngOfSize(w, h), 'image/png'), `png ${w}x${h}`).toBe('DIMENSIONS_TOO_LARGE');
      expect(refusal(jpegOfSize(w, h), 'image/jpeg'), `jpeg ${w}x${h}`).toBe(
        'DIMENSIONS_TOO_LARGE',
      );
    }
    // PNG allows up to 2^31 - 1 per side: 4.6 * 10^18 pixels declared in 57 bytes.
    const bomb = pngOfSize(0x7fffffff, 0x7fffffff);
    expect(bomb.length).toBeLessThan(64);
    expect(refusal(bomb, 'image/png')).toBe('DIMENSIONS_TOO_LARGE');
    // Progressive and other frame types are measured too.
    for (const marker of [0xc1, 0xc2, 0xc3, 0xc9, 0xca]) {
      expect(refusal(jpegOf(dqt(), sof(20_000, 20_000, marker), sos()), 'image/jpeg')).toBe(
        'DIMENSIONS_TOO_LARGE',
      );
    }
    // A hierarchical DHP header declares the full image size.
    expect(
      refusal(
        jpegOf(dqt(), segment(0xde, sof(20_000, 20_000).slice(4)), sof(1, 1), sos()),
        'image/jpeg',
      ),
    ).toBe('DIMENSIONS_TOO_LARGE');
  });

  it('refuses from the header, before any image data is examined', () => {
    // The data after the header is truncated garbage; the size alone decides.
    const png = pngOfSize(50_000, 50_000).slice(0, 8 + 25 + 5);
    expect(refusal(png, 'image/png')).toBe('DIMENSIONS_TOO_LARGE');
    const jpeg = new Uint8Array([0xff, 0xd8, ...dqt(), ...sof(50_000, 50_000), 0xff, 0xda, 0x00]);
    expect(refusal(jpeg, 'image/jpeg')).toBe('DIMENSIONS_TOO_LARGE');
  });

  it('treats zero or missing dimensions as malformed', () => {
    expect(refusal(pngOfSize(0, 100), 'image/png')).toBe('MALFORMED');
    expect(refusal(pngOfSize(100, 0), 'image/png')).toBe('MALFORMED');
    expect(refusal(jpegOfSize(0, 100), 'image/jpeg')).toBe('MALFORMED');
    // Height 0 defers it to a DNL marker, which common decoders do not support.
    expect(refusal(jpegOfSize(100, 0), 'image/jpeg')).toBe('MALFORMED');
  });

  it('refuses truncated or inconsistent headers', () => {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const cases: [string, Uint8Array, string][] = [
      // Both have image data, so only the IHDR length check can refuse them.
      [
        'png IHDR too short',
        new Uint8Array([
          ...signature,
          ...chunk('IHDR', ihdr(1, 1).slice(0, 12)),
          ...chunk('IDAT', [1, 2, 3]),
          ...chunk('IEND', []),
        ]),
        'image/png',
      ],
      [
        'png IHDR too long',
        new Uint8Array([
          ...signature,
          ...chunk('IHDR', [...ihdr(1, 1), 0]),
          ...chunk('IDAT', [1, 2, 3]),
          ...chunk('IEND', []),
        ]),
        'image/png',
      ],
      [
        'png IHDR not the first chunk',
        new Uint8Array([
          ...signature,
          ...chunk('gAMA', [0, 0, 0xb1, 0x8f]),
          ...chunk('IHDR', ihdr(1, 1)),
          ...chunk('IDAT', [1]),
          ...chunk('IEND', []),
        ]),
        'image/png',
      ],
      ['png two IHDR chunks', pngOfSize(1, 1, [chunk('IHDR', ihdr(50_000, 50_000))]), 'image/png'],
      [
        'png without IHDR',
        new Uint8Array([...signature, ...chunk('IDAT', [1]), ...chunk('IEND', [])]),
        'image/png',
      ],
      [
        'png without image data',
        new Uint8Array([...signature, ...chunk('IHDR', ihdr(1, 1)), ...chunk('IEND', [])]),
        'image/png',
      ],
      ['png cut inside IHDR', pngOfSize(1, 1).slice(0, 8 + 8 + 6), 'image/png'],
      [
        'jpeg frame header too short',
        jpegOf(dqt(), segment(0xc0, [8, 0, 1, 0]), sos()),
        'image/jpeg',
      ],
      [
        'jpeg frame length disagrees with its component count',
        jpegOf(dqt(), segment(0xc0, [8, 0, 1, 0, 1, 3, 1, 0x11, 0]), sos()),
        'image/jpeg',
      ],
      [
        'jpeg frame with no components',
        jpegOf(dqt(), segment(0xc0, [8, 0, 1, 0, 1, 0]), sos()),
        'image/jpeg',
      ],
      ['jpeg cut inside the frame header', jpegOfSize(1, 1).slice(0, 2 + 69 + 6), 'image/jpeg'],
    ];
    for (const [name, bytes, mime] of cases) expect(refusal(bytes, mime), name).toBe('MALFORMED');
  });

  it('refuses a JPEG with more than one frame header, no frame header, or a scan before its frame', () => {
    // A small first frame must not hide a huge second one (or vice versa).
    expect(refusal(jpegOf(dqt(), sof(1, 1), sof(50_000, 50_000, 0xc2), sos()), 'image/jpeg')).toBe(
      'MALFORMED',
    );
    expect(refusal(jpegOf(dqt(), sof(8, 8), sof(8, 8), sos()), 'image/jpeg')).toBe('MALFORMED');
    expect(refusal(jpegOf(dqt(), sof(8, 8), sos(), sof(8, 8), sos()), 'image/jpeg')).toBe(
      'MALFORMED',
    );
    // No SOF at all: nothing says how big the image is.
    expect(refusal(jpegOf(dqt(), sos()), 'image/jpeg')).toBe('MALFORMED');
    expect(refusal(jpegOf(segment(0xe1, ascii('Exif\0\0'))), 'image/jpeg')).toBe('MALFORMED');
    // Scan data before the frame header.
    expect(refusal(jpegOf(dqt(), sos(), sof(8, 8)), 'image/jpeg')).toBe('MALFORMED');
    // A frame but no scan: there is no image to read.
    expect(refusal(jpegOf(dqt(), sof(8, 8)), 'image/jpeg')).toBe('MALFORMED');
  });
});

describe('decoder work bounds besides the pixel count (AC_CAPTURE_02 residual bombs)', () => {
  /** Frame header with `components` components (three bytes each). */
  const sofWith = (width: number, height: number, components: number, marker = 0xc0) =>
    segment(marker, [
      8,
      ...u16(height),
      ...u16(width),
      components,
      ...Array.from({ length: components }, (_, k) => [k + 1, 0x11, 0]).flat(),
    ]);
  const scans = (count: number) => Array.from({ length: count }, sos);
  const pngWithIdat = (...idat: number[][]) =>
    new Uint8Array([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      ...chunk('IHDR', ihdr(10, 10)),
      ...idat.flatMap((data) => chunk('IDAT', data)),
      ...chunk('IEND', []),
    ]);

  it('refuses a JPEG frame with more than four colour components', () => {
    // Photos have 1 (grey), 3 (YCbCr) or 4 (CMYK/YCCK) components; the format allows 255, and a
    // decoder allocates per component.
    for (const components of [1, 3, 4]) {
      expect(
        refusal(jpegOf(dqt(), sofWith(1000, 1000, components), sos()), 'image/jpeg'),
        `Nf=${components}`,
      ).toBeNull();
    }
    for (const components of [5, 255]) {
      expect(
        refusal(jpegOf(dqt(), sofWith(1000, 1000, components), sos()), 'image/jpeg'),
        `Nf=${components}`,
      ).toBe('TOO_COMPLEX');
    }
    // The hierarchical DHP header is held to the same bound.
    expect(
      refusal(
        jpegOf(dqt(), segment(0xde, sofWith(8, 8, 5).slice(4)), sof(8, 8), sos()),
        'image/jpeg',
      ),
    ).toBe('TOO_COMPLEX');
  });

  it('refuses a progressive JPEG with far more scans than any encoder writes', () => {
    // libjpeg's standard progression writes 10 scans (18 for four components); 100 is the ceiling.
    expect(refusal(jpegOf(dqt(), sof(8000, 6000, 0xc2), ...scans(100)), 'image/jpeg')).toBeNull();
    expect(refusal(jpegOf(dqt(), sof(8, 8, 0xc2), ...scans(101)), 'image/jpeg')).toBe(
      'TOO_COMPLEX',
    );
    // A 48 MP frame with 20,000 scans in about 200 KB: every scan makes a decoder re-walk the image.
    const bomb = jpegOf(dqt(), sof(8000, 6000, 0xc2), ...scans(20_000));
    expect(bomb.length).toBeLessThan(250_000);
    expect(refusal(bomb, 'image/jpeg')).toBe('TOO_COMPLEX');
  });

  it('a PNG needs actual image data, not only empty IDAT chunks', () => {
    expect(refusal(pngWithIdat([]), 'image/png')).toBe('MALFORMED');
    expect(refusal(pngWithIdat([], []), 'image/png')).toBe('MALFORMED');
    // An empty IDAT next to one that carries data is harmless.
    expect(refusal(pngWithIdat([], [1, 2, 3]), 'image/png')).toBeNull();
  });

  it('drops a DNL segment, so only the checked frame header says how tall the image is', () => {
    // Height 0 (which needs DNL) is already refused; a DNL after the first scan could "redefine"
    // the height in a decoder that honours it, so it is never forwarded.
    const input = jpegOf(dqt(), sof(100, 100), sos(), segment(0xdc, u16(65_535)));
    const out = stripImageMetadata(input, 'image/jpeg');
    expect(out.some((b, k) => b === 0xff && out[k + 1] === 0xdc)).toBe(false);
    expect(hasBytes(out, String.fromCharCode(0xff, 0xc0, 0x00, 0x0b, 8, 0, 100, 0, 100))).toBe(
      true,
    );
    expect(Array.from(out.slice(-2))).toEqual([0xff, 0xd9]);
  });
});
