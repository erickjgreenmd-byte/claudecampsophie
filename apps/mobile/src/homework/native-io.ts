/**
 * Native file I/O for scans: read bytes, fingerprint them, PUT them to a signed storage URL, and
 * re-encode photos. Not unit-tested (needs a device); the orchestration in upload.ts is.
 */
import { CryptoDigestAlgorithm, digest } from 'expo-crypto';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { toHex, UploadTransferError, type UploadIo } from './upload.ts';

/**
 * A storage PUT is given up after this much total time. Pages are re-encoded JPEGs of a few MB, so
 * a healthy connection finishes in seconds; a half-open one no longer spins forever.
 */
export const UPLOAD_PUT_TIMEOUT_MS = 120_000;

export const nativeUploadIo: UploadIo = {
  async readBytes(uri) {
    const response = await fetch(uri);
    return new Uint8Array(await response.arrayBuffer());
  },
  async sha256Hex(bytes) {
    return toHex(new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, bytes)));
  },
  async putBytes(url, bytes, mimeType, signal) {
    // The scan's signal stops the PUT; the timer gives up on a stalled connection (MOB-R1-03 for
    // the storage leg). Built from AbortController + setTimeout only (Hermes-safe).
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort);
    const timer = setTimeout(() => controller.abort(), UPLOAD_PUT_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'PUT',
        body: bytes,
        headers: { 'content-type': mimeType, 'x-upsert': 'false' },
        signal: controller.signal,
      });
      if (!response.ok) throw new UploadTransferError(response.status);
    } catch (error) {
      // The scan was stopped: upload.ts reports that as cancelled, not as a failed transfer.
      if (signal.aborted) throw error;
      // Our own timer fired: a transfer failure the parent can retry (status 0 = no response).
      if (controller.signal.aborted) throw new UploadTransferError(0);
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  },
};

/**
 * Re-encodes a photo as JPEG, optionally rotated. Re-encoding drops EXIF/GPS metadata on the device
 * (spec P4); the server-side scan job must still strip metadata before any processing because this
 * step can fail and falls back to the original file.
 */
export async function normalizePhoto(uri: string, rotateDegrees = 0): Promise<string> {
  const context = ImageManipulator.manipulate(uri);
  if (rotateDegrees !== 0) context.rotate(rotateDegrees);
  const image = await context.renderAsync();
  const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.85 });
  return saved.uri;
}
