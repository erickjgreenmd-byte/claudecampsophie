/**
 * Sends a child's scan (spec P5; AC_CAPTURE_01 interrupted upload + resume, AC_CAPTURE_06 duplicate
 * events). Order: read + hash each page on the device → create the scan (idempotent key) → register
 * pages and receive signed URLs → PUT bytes straight to storage → finalize (idempotent).
 *
 * Resume: the screen keeps the same `UploadAttempt` across retries, so the same keys return the same
 * scan and the server marks pages already stored; only missing pages are sent again. When the create
 * shows the scan was already finalized (a lost finalize response), the retry reports it as sent
 * without touching pages again. Pure logic with injected I/O so it is unit-testable without a device.
 *
 * Memory (MOB-R1-04): a page's bytes live in the JS heap only while they are being fingerprinted or
 * sent. The first pass reads, measures and hashes each page and drops the bytes; each page is read
 * again just before its PUT. A ten-page scan therefore holds one page at a time, not ~150 MB.
 * Cancellation (MOB-R1-03): the scan's AbortSignal reaches every API call, not only the storage PUT,
 * so "Stop sending" also stops a stalled create/register/finalize request.
 */
import {
  FINALIZED_ASSIGNMENT_STATUSES,
  assignmentStateResponseSchema,
  homeworkScanFits,
  uploadPagesResponseSchema,
  type AssignmentState,
  type HomeworkUploadLimits,
} from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import {
  isAllowedType,
  isPictureTooBig,
  pictureTooBigCopy,
  type PageProblem,
  type ScanPage,
} from './scan-session.ts';

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

/**
 * The scan this attempt belongs to was stopped on the server (cancelled, e.g. by a grown-up, or
 * deleted). Its pages cannot be sent any more; the screen starts a fresh attempt so "Try again"
 * sends the same pages as a new scan.
 */
export class ScanStoppedError extends Error {
  constructor() {
    super('stopped');
    this.name = 'ScanStoppedError';
  }
}

/** A page failed a limit before upload (type or picture size), or once its bytes were measured. */
export class PageLimitError extends Error {
  readonly pageNumber: number;
  readonly problem: PageProblem;
  constructor(pageNumber: number, problem: PageProblem) {
    super(problem);
    this.name = 'PageLimitError';
    this.pageNumber = pageNumber;
    this.problem = problem;
  }
}

/**
 * All pages together are over HOMEWORK_SCAN_MAX_TOTAL_BYTES (R2C-MOB-2). With the 2,000 px downscale
 * only the fallback path (the downscale failed and the original photo is sent) can reach it. Found
 * on the device before any API call, so no scan is created and no allowance is reserved.
 */
export class ScanTooLargeError extends Error {
  constructor() {
    super('scan too large');
    this.name = 'ScanTooLargeError';
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

/** An API call that failed because the child stopped the scan is a cancellation, not a network fault. */
async function cancellable<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  checkCancelled(signal);
  try {
    return await work();
  } catch (error) {
    if (signal.aborted) throw new ScanCancelledError();
    throw error;
  }
}

/**
 * Reads one page's bytes just before its PUT; the buffer goes out of scope as soon as the PUT
 * returns. A file that changed since it was fingerprinted is refused here rather than sent, since
 * the server would remove it as a mismatch anyway.
 */
async function sendPage(
  io: UploadIo,
  uploadUrl: string,
  page: { uri: string; mimeType: string; byteSize: number },
  signal: AbortSignal,
): Promise<void> {
  const bytes = await io.readBytes(page.uri);
  if (bytes.length !== page.byteSize) throw new UploadTransferError(0);
  await io.putBytes(uploadUrl, bytes, page.mimeType, signal);
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

  const request = { signal };

  // 1. Measure and fingerprint every page before contacting the API. Only the size and the hash
  // are kept; the bytes are read again, one page at a time, when they are sent.
  const prepared: {
    pageNumber: number;
    uri: string;
    mimeType: string;
    byteSize: number;
    sha256: string;
  }[] = [];
  for (const [i, page] of pages.entries()) {
    checkCancelled(signal);
    onProgress({ phase: 'preparing', pagesDone: i, pagesTotal: total });
    if (!isAllowedType(page.mimeType, limits)) throw new PageLimitError(i + 1, 'unsupported_type');
    // Over the picture size limits (AC_CAPTURE_02): refused before its bytes are even read.
    if (isPictureTooBig(page)) throw new PageLimitError(i + 1, 'too_many_pixels');
    const bytes = await io.readBytes(page.uri);
    if (bytes.length === 0 || bytes.length > limits.maxPageBytes) {
      throw new PageLimitError(i + 1, 'too_large');
    }
    prepared.push({
      pageNumber: i + 1,
      uri: page.uri,
      mimeType: page.mimeType,
      byteSize: bytes.length,
      sha256: await io.sha256Hex(bytes),
    });
  }
  checkCancelled(signal);
  // The server refuses the same bound at registration (SCAN_TOO_LARGE); checking here first means
  // an oversize scan never creates a draft or reserves allowance.
  if (!homeworkScanFits(prepared.map((p) => p.byteSize))) throw new ScanTooLargeError();

  // 2. Create (or, with the same key, find) the scan. A child never names a child id.
  const created = await cancellable(signal, () =>
    api.send(
      'POST',
      '/v1/assignments',
      { pageCount: total, idempotencyKey: args.attempt.createKey },
      assignmentStateResponseSchema,
      request,
    ),
  );
  const attempt: UploadAttempt = { ...args.attempt, assignmentId: created.assignment.id };
  args.onAttempt?.(attempt);
  const base = `/v1/assignments/${attempt.assignmentId}`;
  // Same key, same scan: if an earlier try already finalized it, it was sent. Registering pages
  // again would be refused, so report it as sent (RV-homework-4; AC_CAPTURE_06 one job, one charge).
  if (FINALIZED_ASSIGNMENT_STATUSES.includes(created.assignment.status)) {
    onProgress({ phase: 'done', pagesDone: total, pagesTotal: total });
    return { assignment: created.assignment, attempt };
  }
  if (created.assignment.status === 'cancelled' || created.assignment.status === 'deleted') {
    throw new ScanStoppedError();
  }

  // 3. Register pages (or resume) and receive single-object signed upload URLs.
  checkCancelled(signal);
  const registered = await cancellable(signal, () =>
    api.send(
      'POST',
      `${base}/uploads`,
      {
        pages: prepared.map((p) => ({
          pageNumber: p.pageNumber,
          mimeType: p.mimeType,
          byteSize: p.byteSize,
          sha256: p.sha256,
        })),
      },
      uploadPagesResponseSchema,
      request,
    ),
  );

  // 4. Send bytes straight to storage, one page in memory at a time; pages already stored are
  // skipped (resume).
  let done = registered.uploads.filter((u) => u.alreadyUploaded).length;
  onProgress({ phase: 'uploading', pagesDone: done, pagesTotal: total });
  for (const target of registered.uploads) {
    if (target.alreadyUploaded) continue;
    checkCancelled(signal);
    const page = prepared.find((p) => p.pageNumber === target.pageNumber);
    if (!page) throw new UploadTransferError(0);
    await sendPage(io, target.uploadUrl, page, signal);
    done += 1;
    onProgress({ phase: 'uploading', pagesDone: done, pagesTotal: total });
  }
  checkCancelled(signal);

  // 5. Finalize (idempotent: repeating it never double-charges or double-queues).
  onProgress({ phase: 'sending', pagesDone: total, pagesTotal: total });
  const finalized = await cancellable(signal, () =>
    api.send(
      'POST',
      `${base}/finalize`,
      { idempotencyKey: attempt.finalizeKey },
      assignmentStateResponseSchema,
      request,
    ),
  );
  onProgress({ phase: 'done', pagesDone: total, pagesTotal: total });
  return { assignment: finalized.assignment, attempt };
}

/**
 * Tells the server to stop a scan the child abandoned; releases any reserved page allowance.
 *
 * Every answer is an answer the caller can act on, including "the request did not land" (HUNT5-H-4):
 * a cancel refused INVALID_TRANSITION is 'too_late' (the scan is already being checked), and a cancel
 * that failed any other way — offline, the client's own timeout, a 5xx, a 429 — is 'unsure', because
 * this device cannot know whether the server stopped the scan. It used to rethrow those, and the one
 * caller turned the throw into 'cancelled', which told the child the scan had stopped when it may
 * well have been sent.
 */
export async function cancelScan(
  api: ApiClient,
  attempt: UploadAttempt,
): Promise<'cancelled' | 'nothing_to_cancel' | 'too_late' | 'unsure'> {
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
    return 'unsure';
  }
}

export interface StoppedScanOutcome {
  /** Child-facing copy for the scan the child stopped. */
  readonly message: string;
  /**
   * True when the SAME attempt must be kept, so "Try again" re-creates with the same idempotency
   * keys and the server answers with the assignment it already has.
   */
  readonly keepAttempt: boolean;
}

/**
 * What to tell the child, and whether to keep the attempt, after they stopped a scan (HUNT4-MOB-5).
 *
 * "Stop sending" tapped during the finalize round trip aborts the request, but the server may have
 * committed the finalize; once the scan job moves the assignment out of 'queued' the cancel that
 * follows is refused INVALID_TRANSITION, which cancelScan reports as 'too_late'. Saying "Stopped" and
 * starting a fresh attempt there told the child the scan had stopped while it was being checked and
 * charged, and let "Try again" create a SECOND assignment for the same homework — two jobs and two
 * page-allowance charges against AC_CAPTURE_06's one job, one charge. So 'too_late' keeps the attempt
 * and says the scan was already on its way.
 *
 * 'unsure' — the cancel itself never reached the server (HUNT5-H-4) — keeps the attempt for the same
 * reason and says so plainly: this device cannot promise the scan stopped, and the retained keys make
 * "Try again" the same scan whatever the server did, so one piece of homework is never checked and
 * charged twice.
 */
export function stoppedScanOutcome(
  cancel: 'cancelled' | 'nothing_to_cancel' | 'too_late' | 'unsure',
): StoppedScanOutcome {
  if (cancel === 'too_late') {
    return { message: 'That one was already sent. You can see it in My scans.', keepAttempt: true };
  }
  if (cancel === 'unsure') {
    return {
      message: 'We couldn’t stop that one. Check My scans to see if it went.',
      keepAttempt: true,
    };
  }
  return { message: childUploadMessage(new ScanCancelledError()), keepAttempt: false };
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

const SCAN_TOO_LARGE_COPY = 'These pictures are too big to send together. Ask a grown-up to help.';

const RULE_COPY: Record<string, string> = {
  QUOTA_EXCEEDED: 'That’s a lot of scanning this month! Ask a grown-up to help with this one.',
  CONSENT_REQUIRED: 'A grown-up needs to finish setting up PencilLift before you can scan.',
  CHILD_NOT_ACTIVE: 'A grown-up needs to finish setting up PencilLift before you can scan.',
  TOO_MANY_PAGES: 'That’s more pages than fit in one scan. Remove a page or two.',
  PAGE_TOO_LARGE: 'One page is too big. Try taking that photo again.',
  UNSUPPORTED_FILE_TYPE:
    'One page is a kind of file PencilLift can’t read yet. Try taking a photo of the page instead.',
  UPLOAD_INCOMPLETE: 'Some pages didn’t finish sending. Let’s try again.',
  // HEIC/PDF are refused at registration until the converter ships (the app never sends them).
  FORMAT_NOT_SUPPORTED_YET:
    'One page is a kind of file PencilLift can’t read yet. Try taking a photo of the page instead.',
  // The server removed pages that arrived different from what was registered; a retry re-sends them.
  UPLOAD_MISMATCH: 'Some pages got mixed up on the way. Let’s try sending them again.',
  // All pages together are over HOMEWORK_SCAN_MAX_TOTAL_BYTES (R2C-MOB-2).
  SCAN_TOO_LARGE: SCAN_TOO_LARGE_COPY,
};

/** Calm, blame-free words for every failure; raw server text is never shown to a child. */
export function childUploadMessage(error: unknown): string {
  if (error instanceof ScanCancelledError) return 'Stopped. Your pages are still here.';
  if (error instanceof ScanTooLargeError) return SCAN_TOO_LARGE_COPY;
  if (error instanceof ScanStoppedError) {
    return 'That scan was stopped. Your pages are still here — tap “Try again” to send them as a new scan.';
  }
  if (error instanceof PageLimitError) {
    switch (error.problem) {
      case 'too_large':
        return `Page ${error.pageNumber} is too big or empty. Try taking that photo again.`;
      case 'too_many_pixels':
        return pictureTooBigCopy(error.pageNumber);
      case 'unsupported_type':
        return `Page ${error.pageNumber} is a kind of file PencilLift can’t read yet. Try taking a photo of the page instead.`;
    }
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
