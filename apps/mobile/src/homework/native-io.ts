/**
 * Native file I/O for scans: read bytes, fingerprint them, PUT them to a signed storage URL, and
 * re-encode photos. Not unit-tested (needs a device); the orchestration in upload.ts is.
 */
import { CryptoDigestAlgorithm, digest } from 'expo-crypto';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { toHex, UploadTransferError, type UploadIo } from './upload.ts';

export const nativeUploadIo: UploadIo = {
  async readBytes(uri) {
    const response = await fetch(uri);
    return new Uint8Array(await response.arrayBuffer());
  },
  async sha256Hex(bytes) {
    return toHex(new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, bytes)));
  },
  async putBytes(url, bytes, mimeType, signal) {
    const response = await fetch(url, {
      method: 'PUT',
      body: bytes,
      headers: { 'content-type': mimeType, 'x-upsert': 'false' },
      signal,
    });
    if (!response.ok) throw new UploadTransferError(response.status);
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
