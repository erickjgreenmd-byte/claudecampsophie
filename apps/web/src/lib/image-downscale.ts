/**
 * R2C-WEB-1: shrink a homework photo in the browser before it is uploaded.
 *
 * All pages of one scan together are bounded (HOMEWORK_SCAN_MAX_TOTAL_BYTES, 15 MiB: one AI
 * extraction request built in a Worker's memory). Raw phone photos are 3–6 MB each, so the web
 * portal draws each picked JPEG/PNG onto a canvas with its longest side at most 2,000 px and encodes
 * it as JPEG at quality 0.85 — the same as the mobile app — which also leaves the photo's EXIF/GPS
 * metadata behind (the server strips it anyway). Homework legibility needs far less than a camera's
 * full resolution; the AI provider downsizes large images before reading them.
 *
 * When the browser cannot decode, draw or encode the image (an unsupported format, a very old
 * browser, jsdom in tests) the original file is uploaded unchanged; the scan-size pre-check and the
 * server's limits apply either way.
 */

export const DOWNSCALE_MAX_SIDE_PX = 2000;
export const DOWNSCALE_JPEG_QUALITY = 0.85;

const DOWNSCALED_TYPES: readonly string[] = ['image/jpeg', 'image/png'];

export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  close?(): void;
}

interface Drawing2d {
  fillStyle: unknown;
  fillRect(x: number, y: number, width: number, height: number): void;
  drawImage(image: never, dx: number, dy: number, dw: number, dh: number): void;
}

export interface DownscaleCanvas {
  getContext(type: '2d'): Drawing2d | null;
  /** Resolves null when the browser produced no image. */
  toBlob(type: string, quality: number): Promise<Blob | null>;
  /** Frees the canvas's pixels once the blob exists (optional). */
  release?(): void;
}

/** The browser pieces the helper needs; tests pass labeled fakes. */
export interface DownscaleEnv {
  decode(file: Blob): Promise<DecodedImage>;
  createCanvas(width: number, height: number): DownscaleCanvas;
}

/** The real browser environment, or null when it can't decode images off the page (jsdom). */
export function browserDownscaleEnv(): DownscaleEnv | null {
  if (typeof globalThis.createImageBitmap !== 'function') return null;
  const hasOffscreen = typeof globalThis.OffscreenCanvas === 'function';
  if (!hasOffscreen && typeof document === 'undefined') return null;
  return {
    // `from-image` applies the photo's EXIF orientation before the metadata is dropped.
    decode: (file) => createImageBitmap(file, { imageOrientation: 'from-image' }),
    createCanvas: (width, height): DownscaleCanvas => {
      if (hasOffscreen) {
        const canvas = new OffscreenCanvas(width, height);
        return {
          getContext: () => canvas.getContext('2d'),
          toBlob: (type, quality) => canvas.convertToBlob({ type, quality }),
          release: () => {
            canvas.width = 0;
            canvas.height = 0;
          },
        };
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      return {
        getContext: () => canvas.getContext('2d'),
        toBlob: (type, quality) =>
          new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality)),
        release: () => {
          canvas.width = 0;
          canvas.height = 0;
        },
      };
    },
  };
}

/** Longest side at most DOWNSCALE_MAX_SIDE_PX; never smaller than 1 px on a side. */
function targetSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, DOWNSCALE_MAX_SIDE_PX / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function jpegName(name: string): string {
  const dot = name.lastIndexOf('.');
  return `${dot > 0 ? name.slice(0, dot) : name}.jpg`;
}

/**
 * The file to upload for a picked photo: a JPEG at most 2,000 px on its longest side, or the
 * original when the browser can't make one. Never throws.
 */
export async function downscaleForUpload(
  file: File,
  env: DownscaleEnv | null = browserDownscaleEnv(),
): Promise<File> {
  if (!env || !DOWNSCALED_TYPES.includes(file.type)) return file;
  let image: DecodedImage | null = null;
  let canvas: DownscaleCanvas | null = null;
  try {
    image = await env.decode(file);
    const { width, height } = image;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
      return file;
    }
    const target = targetSize(width, height);
    canvas = env.createCanvas(target.width, target.height);
    const context = canvas.getContext('2d');
    if (!context) return file;
    // A white page behind the picture, so transparent parts of a PNG don't turn black as JPEG.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, target.width, target.height);
    context.drawImage(image as never, 0, 0, target.width, target.height);
    const blob = await canvas.toBlob('image/jpeg', DOWNSCALE_JPEG_QUALITY);
    // A browser that can't encode JPEG silently returns PNG; keep the original then.
    if (!blob || blob.type !== 'image/jpeg' || blob.size === 0) return file;
    return new File([blob], jpegName(file.name), {
      type: 'image/jpeg',
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  } finally {
    image?.close?.();
    canvas?.release?.();
  }
}
