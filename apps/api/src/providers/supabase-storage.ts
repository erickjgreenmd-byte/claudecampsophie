import type { StorageProvider } from './index.ts';

/**
 * Supabase Storage REST adapter for private homework pages (spec P4/P5; migration 0100 creates the
 * private `homework` bucket). Server-only: it holds the service-role key, which must come from a
 * Worker secret and is never sent to a browser or device.
 *
 * Status: UNTESTED AGAINST A LIVE SERVICE. The request shapes follow the documented Storage API
 * (see below); the API test suite uses the labeled in-memory mock instead. Before production, run the
 * adapter against a staging project and record the evidence in docs/Connections.md.
 *
 * Endpoints used (base `${supabaseUrl}/storage/v1`):
 * - POST   /object/upload/sign/{bucket}/{path}  → `{ url }` (relative, contains the upload token)
 * - POST   /object/sign/{bucket}/{path}         `{ expiresIn }` → `{ signedURL }` (relative)
 * - HEAD   /object/{bucket}/{path}              200 when present, 400/404 when absent
 * - GET    /object/info/{bucket}/{path}         `{ size, content_type, etag, ... }` (storage-api
 *                                               InfoRenderer); absent only when the error body
 *                                               names a missing object (ERRORS.NoSuchKey: 400 or
 *                                               404 with statusCode "404" and code "NoSuchKey", or
 *                                               no code and error "not_found")
 * - DELETE /object/{bucket}                     `{ prefixes: [...] }`
 *
 * Content hashes: the info response carries only the S3 ETag, which is an MD5 for single-part
 * uploads and not a content digest at all for multipart ones. There is no SHA-256, so `stat` reports
 * the measured size only; checking the registered sha256 would mean downloading every page.
 */

export interface SupabaseStorageOptions {
  /** Project URL, e.g. https://<project>.supabase.co (http only for localhost development). */
  readonly supabaseUrl: string;
  /** Service-role (secret) key from Worker secrets. */
  readonly serviceRoleKey: string;
  /** Private bucket name; defaults to `homework`. */
  readonly bucket?: string;
  readonly fetchImpl?: typeof fetch;
  readonly clock?: () => Date;
  /** Per-request timeout (spec P12: every external request has a timeout). */
  readonly timeoutMs?: number;
}

/**
 * Supabase fixes signed upload URL lifetime server-side (two hours); a shorter requested lifetime is
 * reported honestly as the real expiry rather than pretending the URL expires sooner.
 */
const SIGNED_UPLOAD_LIFETIME_SECONDS = 2 * 60 * 60;
const REMOVE_BATCH = 1000;

export class StorageRequestError extends Error {
  readonly status: number;
  constructor(operation: string, status: number) {
    // Status only: response bodies can echo object paths and are not needed for handling.
    super(`Supabase Storage ${operation} failed with HTTP ${status}`);
    this.name = 'StorageRequestError';
    this.status = status;
  }
}

function assertBaseUrl(raw: string): string {
  const url = new URL(raw);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('Supabase Storage URL must use https');
  }
  return `${url.origin}/storage/v1`;
}

/** Encodes an object path segment by segment and refuses traversal or empty segments. */
export function encodeObjectPath(path: string): string {
  const segments = path.split('/');
  if (
    path.length === 0 ||
    path.length > 1024 ||
    segments.some((s) => s.length === 0 || s === '.' || s === '..')
  ) {
    throw new Error('Invalid storage object path');
  }
  return segments.map((s) => encodeURIComponent(s)).join('/');
}

export function createSupabaseStorage(options: SupabaseStorageOptions): StorageProvider {
  const base = assertBaseUrl(options.supabaseUrl);
  if (options.serviceRoleKey.length < 20) throw new Error('Supabase service key is missing');
  const bucket = encodeURIComponent(options.bucket ?? 'homework');
  const fetchImpl = options.fetchImpl ?? fetch;
  const clock = options.clock ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? 10_000;
  const auth = {
    authorization: `Bearer ${options.serviceRoleKey}`,
    apikey: options.serviceRoleKey,
  };

  async function call(
    operation: string,
    method: string,
    url: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
    absentIsAnswer = method === 'HEAD',
  ): Promise<Response> {
    const headers: Record<string, string> = { ...auth, ...extraHeaders };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetchImpl(url, {
      method,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok && !(absentIsAnswer && (response.status === 400 || response.status === 404))) {
      throw new StorageRequestError(operation, response.status);
    }
    return response;
  }

  /**
   * True only when the error body names a missing object (storage-api ERRORS.NoSuchKey, rendered
   * as HTTP 400 with statusCode "404"; older versions omit `code`). Any other 400/404 is not an
   * answer about the object: a storage version without the route (Fastify's `error: "Not Found"`),
   * a missing bucket (NoSuchBucket) or a bare 404 from something in between is an error, so a
   * caller never reads "not uploaded" from a misconfiguration.
   */
  async function isAbsent(response: Response): Promise<boolean> {
    if (response.status !== 400 && response.status !== 404) return false;
    const payload: unknown = await response.json().catch(() => null);
    if (typeof payload !== 'object' || payload === null) return false;
    const body = payload as Record<string, unknown>;
    if (String(body.statusCode) !== '404') return false;
    return body.code === 'NoSuchKey' || (body.code === undefined && body.error === 'not_found');
  }

  async function relativeUrl(response: Response, field: 'url' | 'signedURL'): Promise<string> {
    const payload: unknown = await response.json();
    const value =
      typeof payload === 'object' && payload !== null
        ? (payload as Record<string, unknown>)[field]
        : undefined;
    if (typeof value !== 'string' || !value.startsWith('/')) {
      throw new StorageRequestError('signing (unexpected response)', response.status);
    }
    return `${base}${value}`;
  }

  return {
    name: 'supabase_storage',
    isMock: false,

    async createSignedUploadUrl(path, expiresInSeconds) {
      const requestedAt = clock();
      const response = await call(
        'sign upload',
        'POST',
        `${base}/object/upload/sign/${bucket}/${encodeObjectPath(path)}`,
        undefined,
        // Never overwrite an existing page: a page id maps to exactly one set of bytes.
        { 'x-upsert': 'false' },
      );
      const url = await relativeUrl(response, 'url');
      const lifetime = Math.max(expiresInSeconds, SIGNED_UPLOAD_LIFETIME_SECONDS);
      return { url, expiresAt: new Date(requestedAt.getTime() + lifetime * 1000) };
    },

    async createSignedReadUrl(path, expiresInSeconds) {
      const requestedAt = clock();
      const response = await call(
        'sign read',
        'POST',
        `${base}/object/sign/${bucket}/${encodeObjectPath(path)}`,
        { expiresIn: expiresInSeconds },
      );
      const url = await relativeUrl(response, 'signedURL');
      return { url, expiresAt: new Date(requestedAt.getTime() + expiresInSeconds * 1000) };
    },

    async exists(path) {
      const response = await call(
        'exists',
        'HEAD',
        `${base}/object/${bucket}/${encodeObjectPath(path)}`,
      );
      return response.ok;
    },

    async stat(path) {
      const response = await call(
        'stat',
        'GET',
        `${base}/object/info/${bucket}/${encodeObjectPath(path)}`,
        undefined,
        {},
        true,
      );
      if (!response.ok) {
        if (await isAbsent(response)) return null;
        throw new StorageRequestError('stat', response.status);
      }
      const payload: unknown = await response.json().catch(() => null);
      const size =
        typeof payload === 'object' && payload !== null
          ? (payload as Record<string, unknown>).size
          : undefined;
      // A size storage did not report is never guessed (finalize then refuses as unavailable).
      if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
        throw new StorageRequestError('stat (unexpected response)', response.status);
      }
      return { byteSize: size };
    },

    async remove(paths) {
      for (let i = 0; i < paths.length; i += REMOVE_BATCH) {
        const prefixes = paths.slice(i, i + REMOVE_BATCH);
        prefixes.forEach((p) => encodeObjectPath(p)); // validate every path before deleting
        await call('remove', 'DELETE', `${base}/object/${bucket}`, { prefixes });
      }
    },
  };
}
