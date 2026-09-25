import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DOWNSCALE_JPEG_QUALITY,
  DOWNSCALE_MAX_SIDE_PX,
  browserDownscaleEnv,
  downscaleForUpload,
  type DownscaleCanvas,
  type DownscaleEnv,
} from './image-downscale.ts';

/**
 * R2C-WEB-1: the web uploader shrinks each photo before upload (longest side 2,000 px, JPEG 0.85,
 * as the mobile app does) so a scan of ordinary phone photos fits HOMEWORK_SCAN_MAX_TOTAL_BYTES.
 * The bitmap and the canvas below are LABELED FAKES: jsdom has no image decoder or canvas encoder.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Drawn {
  width: number;
  height: number;
  fills: string[];
  draws: { dx: number; dy: number; dw: number; dh: number }[];
  encodes: { type: string; quality: number }[];
}

/** Labeled fake: a decoder that reports the given size and a canvas that records its drawing. */
function fakeEnv(
  size: { width: number; height: number } | Error,
  encoded: (drawn: Drawn) => Blob | null = () =>
    new Blob([new Uint8Array(300_000)], { type: 'image/jpeg' }),
) {
  const canvases: Drawn[] = [];
  const closed: number[] = [];
  const decode = vi.fn((file: Blob) => {
    void file;
    if (size instanceof Error) return Promise.reject(size);
    return Promise.resolve({ ...size, close: () => closed.push(1) });
  });
  const env: DownscaleEnv = {
    decode,
    createCanvas: (width, height): DownscaleCanvas => {
      const drawn: Drawn = { width, height, fills: [], draws: [], encodes: [] };
      canvases.push(drawn);
      return {
        getContext: () => ({
          fillStyle: '',
          fillRect() {
            drawn.fills.push(String(this.fillStyle));
          },
          drawImage: (_image: unknown, dx: number, dy: number, dw: number, dh: number) => {
            drawn.draws.push({ dx, dy, dw, dh });
          },
        }),
        toBlob: (type, quality) => {
          drawn.encodes.push({ type, quality });
          return Promise.resolve(encoded(drawn));
        },
      };
    },
  };
  return { env, decode, canvases, closed };
}

function photo(name = 'page one.jpg', bytes = 4 * 1024 * 1024, type = 'image/jpeg'): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe('downscaleForUpload (R2C-WEB-1)', () => {
  it('shrinks a landscape phone photo so its longest side is 2,000 px, as JPEG 0.85', async () => {
    const { env, canvases, closed } = fakeEnv({ width: 4032, height: 3024 });
    const out = await downscaleForUpload(photo(), env);
    expect(DOWNSCALE_MAX_SIDE_PX).toBe(2000);
    expect(DOWNSCALE_JPEG_QUALITY).toBe(0.85);
    expect(canvases).toHaveLength(1);
    expect(canvases[0]).toMatchObject({ width: 2000, height: 1500 });
    expect(canvases[0]!.draws).toEqual([{ dx: 0, dy: 0, dw: 2000, dh: 1500 }]);
    expect(canvases[0]!.encodes).toEqual([{ type: 'image/jpeg', quality: 0.85 }]);
    // A white page behind the picture: a transparent PNG does not turn black as JPEG.
    expect(canvases[0]!.fills).toEqual(['#ffffff']);
    expect(out.type).toBe('image/jpeg');
    expect(out.size).toBe(300_000);
    expect(out.name).toBe('page one.jpg');
    expect(closed).toHaveLength(1);
  });

  it('shrinks a portrait photo by its height and re-encodes a PNG as JPEG', async () => {
    const { env, canvases } = fakeEnv({ width: 3000, height: 4000 });
    const out = await downscaleForUpload(photo('scan.png', 1000, 'image/png'), env);
    expect(canvases[0]).toMatchObject({ width: 1500, height: 2000 });
    expect(out.type).toBe('image/jpeg');
    expect(out.name).toBe('scan.jpg');
  });

  it('keeps the size of a photo already within 2,000 px but still re-encodes it (no metadata)', async () => {
    const { env, canvases } = fakeEnv({ width: 1200, height: 900 });
    const out = await downscaleForUpload(photo(), env);
    expect(canvases[0]).toMatchObject({ width: 1200, height: 900 });
    expect(out.type).toBe('image/jpeg');
    expect(out.size).toBe(300_000);
  });

  it('never makes a side zero for an extreme strip', async () => {
    const { env, canvases } = fakeEnv({ width: 9000, height: 3 });
    await downscaleForUpload(photo(), env);
    expect(canvases[0]).toMatchObject({ width: 2000, height: 1 });
  });

  it('falls back to the original file when the browser cannot decode, draw or encode it', async () => {
    const original = photo();
    const undecodable = fakeEnv(new Error('decode failed'));
    expect(await downscaleForUpload(original, undecodable.env)).toBe(original);

    const noJpeg = fakeEnv(
      { width: 4032, height: 3024 },
      () => new Blob([new Uint8Array(10)], { type: 'image/png' }),
    );
    expect(await downscaleForUpload(original, noJpeg.env)).toBe(original);

    const empty = fakeEnv({ width: 4032, height: 3024 }, () => null);
    expect(await downscaleForUpload(original, empty.env)).toBe(original);

    const zero = fakeEnv({ width: 4032, height: 3024 }, () => new Blob([], { type: 'image/jpeg' }));
    expect(await downscaleForUpload(original, zero.env)).toBe(original);

    const noContext = fakeEnv({ width: 4032, height: 3024 });
    const withoutContext: DownscaleEnv = {
      ...noContext.env,
      createCanvas: (w, h) => ({ ...noContext.env.createCanvas(w, h), getContext: () => null }),
    };
    expect(await downscaleForUpload(original, withoutContext)).toBe(original);

    const bogus = fakeEnv({ width: 0, height: 3024 });
    expect(await downscaleForUpload(original, bogus.env)).toBe(original);
  });

  it('leaves files it does not read (not JPEG or PNG) and a missing environment alone', async () => {
    const pdf = photo('guide.pdf', 100, 'application/pdf');
    const { env, decode } = fakeEnv({ width: 4032, height: 3024 });
    expect(await downscaleForUpload(pdf, env)).toBe(pdf);
    expect(decode).not.toHaveBeenCalled();
    const original = photo();
    expect(await downscaleForUpload(original, null)).toBe(original);
  });
});

describe('browserDownscaleEnv (R2C-WEB-1)', () => {
  it('is null in a browser without createImageBitmap (jsdom), so uploads use the original', () => {
    expect(typeof globalThis.createImageBitmap).toBe('undefined');
    expect(browserDownscaleEnv()).toBeNull();
  });

  it('uses createImageBitmap with the photo’s own orientation and an OffscreenCanvas', async () => {
    const decode = vi.fn(() => Promise.resolve({ width: 10, height: 10, close: () => undefined }));
    vi.stubGlobal('createImageBitmap', decode);
    const convertToBlob = vi.fn(() => Promise.resolve(new Blob(['x'], { type: 'image/jpeg' })));
    /** Labeled fake OffscreenCanvas. */
    class FakeOffscreenCanvas {
      constructor(
        readonly width: number,
        readonly height: number,
      ) {}
      getContext() {
        return { fillStyle: '', fillRect: () => undefined, drawImage: () => undefined };
      }
      convertToBlob = convertToBlob;
    }
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    const env = browserDownscaleEnv();
    expect(env).not.toBeNull();
    const file = photo();
    await env!.decode(file);
    expect(decode).toHaveBeenCalledWith(file, { imageOrientation: 'from-image' });
    const canvas = env!.createCanvas(20, 10);
    expect(await canvas.toBlob('image/jpeg', 0.85)).toBeInstanceOf(Blob);
    expect(convertToBlob).toHaveBeenCalledWith({ type: 'image/jpeg', quality: 0.85 });
  });
});
