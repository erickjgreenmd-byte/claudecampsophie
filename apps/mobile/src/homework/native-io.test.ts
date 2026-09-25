import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * JOBS-R1-02: photos are downscaled on the device before the JPEG encode, so a page stays well under
 * 1 MB and a whole scan fits the per-scan byte bound. The native modules are replaced by LABELED
 * test doubles that record what normalizePhoto asks for (no device here).
 */

interface Op {
  readonly op: string;
  readonly arg?: unknown;
}
const ops: Op[] = [];
let source = { width: 0, height: 0 };

function rendered(width: number, height: number) {
  return {
    width,
    height,
    saveAsync: (options: unknown) => {
      ops.push({ op: 'save', arg: options });
      return Promise.resolve({
        uri: `file:///cache/normalized-${width}x${height}.jpg`,
        width,
        height,
      });
    },
  };
}

vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digest: () => Promise.resolve(new ArrayBuffer(32)),
}));

vi.mock('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg', PNG: 'png' },
  ImageManipulator: {
    manipulate: (uri: string) => {
      ops.push({ op: 'manipulate', arg: uri });
      let { width, height } = source;
      let resize: { width?: number; height?: number } | null = null;
      const context = {
        rotate(degrees: number) {
          ops.push({ op: 'rotate', arg: degrees });
          if (Math.abs(degrees) % 180 === 90) [width, height] = [height, width];
          return context;
        },
        resize(size: { width?: number; height?: number }) {
          ops.push({ op: 'resize', arg: size });
          resize = size;
          return context;
        },
        renderAsync() {
          ops.push({ op: 'render' });
          if (resize === null) return Promise.resolve(rendered(width, height));
          const scale = resize.width !== undefined ? resize.width / width : resize.height! / height;
          return Promise.resolve(rendered(Math.round(width * scale), Math.round(height * scale)));
        },
      };
      return context;
    },
  },
}));

const { normalizePhoto, photoResizeFor, PHOTO_MAX_SIDE_PX } = await import('./native-io.ts');

beforeEach(() => {
  ops.length = 0;
});

describe('photoResizeFor', () => {
  it('bounds the longest side at 2,000 px and leaves smaller photos alone', () => {
    expect(PHOTO_MAX_SIDE_PX).toBe(2000);
    expect(photoResizeFor(4032, 3024)).toEqual({ width: 2000 });
    expect(photoResizeFor(3024, 4032)).toEqual({ height: 2000 });
    expect(photoResizeFor(8064, 6048)).toEqual({ width: 2000 });
    expect(photoResizeFor(2000, 1500)).toBeNull();
    expect(photoResizeFor(1200, 1600)).toBeNull();
    expect(photoResizeFor(0, 100)).toBeNull();
    expect(photoResizeFor(Number.NaN, 100)).toBeNull();
  });
});

describe('normalizePhoto', () => {
  it('a 12 MP phone photo is scaled to 2,000 px on its longest side before the JPEG encode', async () => {
    source = { width: 4032, height: 3024 };
    const uri = await normalizePhoto('file:///camera/page-1.jpg');
    expect(uri).toBe('file:///cache/normalized-2000x1500.jpg');
    expect(ops).toEqual([
      { op: 'manipulate', arg: 'file:///camera/page-1.jpg' },
      { op: 'render' },
      { op: 'resize', arg: { width: 2000 } },
      { op: 'render' },
      { op: 'save', arg: { format: 'jpeg', compress: 0.85 } },
    ]);
  });

  it('a rotated portrait page is bounded by its height after the rotation', async () => {
    source = { width: 4032, height: 3024 };
    const uri = await normalizePhoto('file:///camera/page-2.jpg', 90);
    expect(uri).toBe('file:///cache/normalized-1500x2000.jpg');
    expect(ops.map((o) => o.op)).toEqual([
      'manipulate',
      'rotate',
      'render',
      'resize',
      'render',
      'save',
    ]);
    expect(ops.find((o) => o.op === 'resize')?.arg).toEqual({ height: 2000 });
  });

  it('a photo that already fits is only re-encoded (metadata dropped), never enlarged', async () => {
    source = { width: 1600, height: 1200 };
    const uri = await normalizePhoto('file:///camera/page-3.jpg');
    expect(uri).toBe('file:///cache/normalized-1600x1200.jpg');
    expect(ops.map((o) => o.op)).toEqual(['manipulate', 'render', 'save']);
  });
});
