/**
 * Sends a child's scan (spec P5; AC_CAPTURE_01 interrupted upload + resume, AC_CAPTURE_06 duplicate
 * events). Order: read + hash each page on the device → create the scan (idempotent key) → register
 * pages and receive signed URLs → PUT bytes straight to storage → finalize (idempotent).
 *
 * Resume: the screen keeps the same `UploadAttempt` across retries, so the same keys return the same
 * scan and the server marks pages already stored; only missing pages are sent again. Pure logic with
 * injected I/O so it is unit-testable without a device.
 */
import {
  assignmentStateResponseSchema,
  uploadPagesResponseSchema,
  type AssignmentState,
  type HomeworkUploadLimits,
} from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { isAllowedType, type ScanPage } from './scan-session.ts';

/** Page bytes backed by a plain ArrayBuffer (what fetch bodies and digests accept). */
export type PageBytes = Uint8Array<ArrayBuffer>;

export interface UploadIo {
  readBytes(uri: string): Promise<PageBytes>;
  /** Lower-case hex SHA-256. */
  sha256Hex(bytes: PageBytes): Promise<string>;
  putBytes(url: string, bytes: PageBytes, mimeType: string, signal: AbortSignal): Promise<void>;
}

export interface UploadAttempt {
  readonly createKey: string;
  readonly finalizeKey: string;
  readonly assignmentId: string | null;
}

export type UploadPhase = 'preparing' | 'uploading' | 'sending' | 'done';

export interface UploadProgress {
  readonly phase: UploadPhase;
  readonly pagesDone: number;
  readonly pagesTotal: number;
}

export class ScanCancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'ScanCancelledError';
  }
}

/** A PUT to a signed storage URL failed (status only; never the URL, which carries a token). */
export class UploadTransferError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`upload failed (${status})`);
    this.name = 'UploadTransferError';
    this.status = status;
  }
}

/** A page failed a limit once its real bytes were measured. */
export class PageLimitError extends Error {
  readonly pageNumber: number;
  readonly problem: 'too_large' | 'unsupported_type';
  constructor(pageNumber: number, problem: 'too_large' | 'unsupported_type') {
    super(problem);
    this.name = 'PageLimitError';
    this.pageNumber = pageNumber;
    this.problem = problem;
  }
}

export function newAttempt(newKey: () => string): UploadAttempt {
  return { createKey: newKey(), finalizeKey: newKey(), assignmentId: null };
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new ScanCancelledError();
}

export async function uploadScan(args: {
  api: ApiClient;
  io: UploadIo;
  pages: readonly ScanPage[];
  limits: HomeworkUploadLimits;
  attempt: UploadAttempt;
  signal: AbortSignal;
  onProgress: (progress: UploadProgress) => void;
  /** Lets the screen remember the scan id as soon as it exists (for resume and cancel). */
  onAttempt?: (attempt: UploadAttempt) => void;
}): Promise<{ assignment: AssignmentState; attempt: UploadAttempt }> {
  const { api, io, pages, limits, signal, onProgress } = args;
  const total = pages.length;

  // 1. Measure and fingerprint every page before contacting the API.
  const prepared: { pageNumber: number; mimeType: string; bytes: PageBytes; sha256: string }[] = [];
  for (const [i, page] of pages.entries()) {
    checkCancelled(signal);
    onProgress({ phase: 'preparing', pagesDone: i, pagesTotal: total });
    if (!isAllowedType(page.mimeType, limits)) throw new PageLimitError(i + 1, 'unsupported_type');
    const bytes = await io.readBytes(page.uri);
    if (bytes.length === 0 || bytes.length > limits.maxPageBytes) {
      throw new PageLimitError(i + 1, 'too_large');
    }
    prepared.push({
      pageNumber: i + 1,
      mimeType: page.mimeType,
      bytes,
      sha256: await io.sha256Hex(bytes),
    });
  }
  checkCancelled(signal);

  // 2. Create (or, with the same key, find) the scan. A child never names a child id.
  const created = await api.send(
    'POST',
    '/v1/assignments',
    { pageCount: total, idempotencyKey: args.attempt.createKey },
    assignmentStateResponseSchema,
  );
  const attempt: UploadAttempt = { ...args.attempt, assignmentId: created.assignment.id };
  args.onAttempt?.(attempt);
  const base = `/v1/assignments/${attempt.assignmentId}`;

  // 3. Register pages (or resume) and receive single-object signed upload URLs.
  checkCancelled(signal);
  const registered = await api.send(
    'POST',
    `${base}/uploads`,
    {
      pages: prepared.map((p) => ({
        pageNumber: p.pageNumber,
        mimeType: p.mimeType,
        byteSize: p.bytes.length,
        sha256: p.sha256,
      })),
    },
    uploadPagesResponseSchema,
  );

  // 4. Send bytes straight to storage; pages already stored are skipped (resume).
  let done = registered.uploads.filter((u) => u.alreadyUploaded).length;
  onProgress({ phase: 'uploading', pagesDone: done, pagesTotal: total });
  for (const target of registered.uploads) {
    if (target.alreadyUploaded) continue;
    checkCancelled(signal);
    const page = prepared.find((p) => p.pageNumber === target.pageNumber);
    if (!page) throw new UploadTransferError(0);
    await io.putBytes(target.uploadUrl, page.bytes, page.mimeType, signal);
    done += 1;
    onProgress({ phase: 'uploading', pagesDone: done, pagesTotal: total });
  }
  checkCancelled(signal);

  // 5. Finalize (idempotent: repeating it never double-charges or double-queues).
  onProgress({ phase: 'sending', pagesDone: total, pagesTotal: total });
  const finalized = await api.send(
    'POST',
    `${base}/finalize`,
    { idempotencyKey: attempt.finalizeKey },
    assignmentStateResponseSchema,
  );
  onProgress({ phase: 'done', pagesDone: total, pagesTotal: total });
  return { assignment: finalized.assignment, attempt };
}

/** Tells the server to stop a scan the child abandoned; releases any reserved page allowance. */
export async function cancelScan(
  api: ApiClient,
  attempt: UploadAttempt,
): Promise<'cancelled' | 'nothing_to_cancel' | 'too_late'> {
  if (attempt.assignmentId === null) return 'nothing_to_cancel';
  try {
    await api.send(
      'POST',
      `/v1/assignments/${attempt.assignmentId}/cancel`,
      undefined,
      assignmentStateResponseSchema,
    );
    return 'cancelled';
  } catch (error) {
    if (error instanceof ApiRequestError && error.rule === 'INVALID_TRANSITION') return 'too_late';
    throw error;
  }
}

const GENERIC_COPY = 'Something went wrong. Let’s try again.';

const CODE_COPY: Partial<Record<ApiRequestError['code'], string>> = {
  NETWORK: 'You seem to be offline. Your pages are still here — try again when you’re connected.',
  UNAUTHENTICATED: 'Ask a grown-up to connect this device again.',
  RATE_LIMITED: 'Let’s take a little break and try again soon.',
  PROVIDER_UNAVAILABLE: 'We couldn’t send your pages just now. Let’s try again in a moment.',
  BLOCKED_EXTERNAL: 'We couldn’t send your pages just now. Let’s try again in a moment.',
  NOT_CONFIGURED: 'We couldn’t send your pages just now. Let’s try again in a moment.',
};

const RULE_COPY: Record<string, string> = {
  QUOTA_EXCEEDED: 'That’s a lot of scanning this month! Ask a grown-up to help with this one.',
  CONSENT_REQUIRED: 'A grown-up needs to finish setting up PencilLift before you can scan.',
  CHILD_NOT_ACTIVE: 'A grown-up needs to finish setting up PencilLift before you can scan.',
  TOO_MANY_PAGES: 'That’s more pages than fit in one scan. Remove a page or two.',
  PAGE_TOO_LARGE: 'One page is too big. Try taking that photo again.',
  UNSUPPORTED_FILE_TYPE:
    'One page is a kind of file PencilLift can’t read. Try a photo or a PDF instead.',
  UPLOAD_INCOMPLETE: 'Some pages didn’t finish sending. Let’s try again.',
};

/** Calm, blame-free words for every failure; raw server text is never shown to a child. */
export function childUploadMessage(error: unknown): string {
  if (error instanceof ScanCancelledError) return 'Stopped. Your pages are still here.';
  if (error instanceof PageLimitError) {
    return error.problem === 'too_large'
      ? `Page ${error.pageNumber} is too big or empty. Try taking that photo again.`
      : `Page ${error.pageNumber} is a kind of file PencilLift can’t read. Try a photo or a PDF instead.`;
  }
  if (error instanceof UploadTransferError) {
    return 'A page didn’t finish sending. Your pages are still here — let’s try again.';
  }
  if (error instanceof ApiRequestError) {
    if (error.code === 'BUSINESS_RULE') {
      return (error.rule !== undefined ? RULE_COPY[error.rule] : undefined) ?? GENERIC_COPY;
    }
    return CODE_COPY[error.code] ?? GENERIC_COPY;
  }
  return GENERIC_COPY;
}
