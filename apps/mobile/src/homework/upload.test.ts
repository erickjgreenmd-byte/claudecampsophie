import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOMEWORK_UPLOAD_LIMITS,
  HOMEWORK_SCAN_MAX_TOTAL_BYTES,
} from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { toScanPage, type ScanPage } from './scan-session.ts';
import {
  PageLimitError,
  ScanCancelledError,
  ScanStoppedError,
  ScanTooLargeError,
  UploadTransferError,
  cancelScan,
  childUploadMessage,
  newAttempt,
  stoppedScanOutcome,
  toHex,
  uploadScan,
  type UploadIo,
  type UploadProgress,
} from './upload.ts';

const ASSIGNMENT = '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60';
const PAGE_IDS = ['03b02b3c-4d5e-4f6a-9b8c-9d0e1f2a3b4c', '14c13c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'];
const AT = '2026-09-24T15:00:00.000Z';
const limits = DEFAULT_HOMEWORK_UPLOAD_LIMITS;

function state(status: string, pageCount = 2) {
  return {
    assignment: {
      id: ASSIGNMENT,
      subjectId: null,
      status,
      pageCount,
      createdAt: AT,
      updatedAt: AT,
    },
  };
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** Fake API that validates each response through the real contract schema. */
function fakeApi(
  options: { alreadyUploaded?: boolean[]; fail?: (call: Call) => Error | null } = {},
) {
  const calls: Call[] = [];
  const send: ApiClient['send'] = (method, path, body, schema) => {
    const call = { method, path, body };
    calls.push(call);
    const failure = options.fail?.(call);
    if (failure) return Promise.reject(failure);
    let value: unknown;
    if (path === '/v1/assignments') value = state('draft');
    else if (path.endsWith('/uploads')) {
      const pages = (body as { pages: { pageNumber: number }[] }).pages;
      value = {
        ...state('uploading'),
        uploads: pages.map((p, i) => ({
          pageId: PAGE_IDS[i],
          pageNumber: p.pageNumber,
          uploadUrl: `https://storage.example.test/upload/${i + 1}?token=t`,
          method: 'PUT',
          expiresAt: AT,
          alreadyUploaded: options.alreadyUploaded?.[i] ?? false,
        })),
      };
    } else if (path.endsWith('/finalize')) value = state('queued');
    else if (path.endsWith('/cancel')) value = state('cancelled');
    else return Promise.reject(new Error(`unexpected ${path}`));
    return Promise.resolve(schema.parse(value));
  };
  const api: ApiClient = { get: () => Promise.reject(new Error('unexpected GET')), send };
  return { api, calls };
}

function fakeIo(overrides: Partial<UploadIo> = {}) {
  const puts: { url: string; mimeType: string; size: number }[] = [];
  const io: UploadIo = {
    readBytes: (uri) => Promise.resolve(new TextEncoder().encode(`bytes of ${uri}`)),
    sha256Hex: (bytes) => Promise.resolve(toHex(bytes.slice(0, 32)).padEnd(64, '0')),
    putBytes: (url, bytes, mimeType) => {
      puts.push({ url, mimeType, size: bytes.length });
      return Promise.resolve();
    },
    ...overrides,
  };
  return { io, puts };
}

let n = 0;
const newKey = () => `key-${String((n += 1)).padStart(16, '0')}`;

function twoPages(): ScanPage[] {
  return [
    toScanPage({ uri: 'file:///p1.jpg', mimeType: 'image/jpeg' }, 'camera', () => 'a'),
    toScanPage(
      { uri: 'file:///p2.png', mimeType: 'image/png', fileSize: 1000 },
      'library',
      () => 'b',
    ),
  ];
}

describe('uploading a scan (spec P5, AC_CAPTURE_01, AC_CAPTURE_06)', () => {
  it('creates, registers, sends the bytes to signed URLs and finalizes, reporting progress', async () => {
    const { api, calls } = fakeApi();
    const { io, puts } = fakeIo();
    const progress: UploadProgress[] = [];
    const attempt = newAttempt(newKey);
    const result = await uploadScan({
      api,
      io,
      pages: twoPages(),
      limits,
      attempt,
      signal: new AbortController().signal,
      onProgress: (p) => progress.push(p),
    });
    expect(result.assignment.status).toBe('queued');
    expect(result.attempt.assignmentId).toBe(ASSIGNMENT);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /v1/assignments',
      `POST /v1/assignments/${ASSIGNMENT}/uploads`,
      `POST /v1/assignments/${ASSIGNMENT}/finalize`,
    ]);
    // A child never names a child id: the server derives it from the child session.
    expect(calls[0]!.body).toEqual({ pageCount: 2, idempotencyKey: attempt.createKey });
    const registered = (calls[1]!.body as { pages: Record<string, unknown>[] }).pages;
    expect(registered.map((p) => [p.pageNumber, p.mimeType])).toEqual([
      [1, 'image/jpeg'],
      [2, 'image/png'],
    ]);
    expect(registered.every((p) => /^[0-9a-f]{64}$/.test(p.sha256 as string))).toBe(true);
    expect(calls[2]!.body).toEqual({ idempotencyKey: attempt.finalizeKey });
    expect(puts.map((p) => p.mimeType)).toEqual(['image/jpeg', 'image/png']);
    expect(progress.at(-1)).toEqual({ phase: 'done', pagesDone: 2, pagesTotal: 2 });
    expect(progress.some((p) => p.phase === 'uploading' && p.pagesDone === 1)).toBe(true);
  });

  it('resumes an interrupted upload with the same keys and skips pages already stored', async () => {
    const attempt = { ...newAttempt(newKey), assignmentId: ASSIGNMENT };
    const { api, calls } = fakeApi({ alreadyUploaded: [true, false] });
    const { io, puts } = fakeIo();
    await uploadScan({
      api,
      io,
      pages: twoPages(),
      limits,
      attempt,
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
    expect((calls[0]!.body as { idempotencyKey: string }).idempotencyKey).toBe(attempt.createKey);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.url).toContain('/upload/2');
  });

  it('refuses a page that turns out too big once its bytes are read, before contacting the API', async () => {
    const { api, calls } = fakeApi();
    const { io } = fakeIo({ readBytes: () => Promise.resolve(new Uint8Array(20)) });
    const tiny = { ...limits, maxPageBytes: 10 };
    const error = await uploadScan({
      api,
      io,
      pages: twoPages(),
      limits: tiny,
      attempt: newAttempt(newKey),
      signal: new AbortController().signal,
      onProgress: () => undefined,
    }).catch((e: unknown) => e);
    expect(childUploadMessage(error)).toMatch(/too big/);
    expect(calls).toHaveLength(0);
  });

  it('never sends a PDF or HEIC page: the scan job can’t read them until the converter ships', async () => {
    // Server-side they would end failed_final FORMAT_NEEDS_CONVERSION (AC_CAPTURE_01, AC_UX_02).
    for (const [uri, mimeType] of [
      ['file:///guide.pdf', 'application/pdf'],
      ['file:///photo.heic', 'image/heic'],
    ] as const) {
      const { api, calls } = fakeApi();
      const { io, puts } = fakeIo();
      const error = await uploadScan({
        api,
        io,
        pages: [
          toScanPage({ uri: 'file:///p1.jpg', mimeType: 'image/jpeg' }, 'camera', () => 'a'),
          toScanPage({ uri, mimeType, fileSize: 1000 }, 'library', () => 'b'),
        ],
        limits,
        attempt: newAttempt(newKey),
        signal: new AbortController().signal,
        onProgress: () => undefined,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PageLimitError);
      expect(error).toMatchObject({ pageNumber: 2, problem: 'unsupported_type' });
      expect(childUploadMessage(error)).toBe(
        'Page 2 is a kind of file PencilLift can’t read yet. Try taking a photo of the page instead.',
      );
      expect(calls).toHaveLength(0);
      expect(puts).toHaveLength(0);
    }
    const rule = new ApiRequestError('BUSINESS_RULE', 'raw', 422, 'UNSUPPORTED_FILE_TYPE');
    expect(childUploadMessage(rule)).not.toMatch(/PDF/);
  });

  it('stops when cancelled and cancelling tells the server', async () => {
    const controller = new AbortController();
    const { api, calls } = fakeApi();
    const { io } = fakeIo({
      putBytes: () => {
        controller.abort();
        return Promise.resolve();
      },
    });
    const attempt = newAttempt(newKey);
    const error = await uploadScan({
      api,
      io,
      pages: twoPages(),
      limits,
      attempt,
      signal: controller.signal,
      onProgress: () => undefined,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScanCancelledError);
    expect(calls.some((c) => c.path.endsWith('/finalize'))).toBe(false);
    const withId = { ...attempt, assignmentId: ASSIGNMENT };
    expect(await cancelScan(api, withId)).toBe('cancelled');
    expect(calls.at(-1)!.path).toBe(`/v1/assignments/${ASSIGNMENT}/cancel`);
    expect(await cancelScan(api, attempt)).toBe('nothing_to_cancel');
  });

  it('a retry whose scan was already finalized and processed reports it as sent without re-sending pages', async () => {
    // The first try's finalize committed but its response was lost; by the retry the job has run.
    const { api, calls } = fakeApi();
    const send: ApiClient['send'] = (method, path, body, schema) =>
      path === '/v1/assignments'
        ? Promise.resolve(schema.parse(state('needs_rescan')))
        : api.send(method, path, body, schema);
    const { io, puts } = fakeIo();
    const progress: UploadProgress[] = [];
    const attempt = { ...newAttempt(newKey), assignmentId: ASSIGNMENT };
    const result = await uploadScan({
      api: { ...api, send },
      io,
      pages: twoPages(),
      limits,
      attempt,
      signal: new AbortController().signal,
      onProgress: (p) => progress.push(p),
    });
    expect(result.assignment.status).toBe('needs_rescan');
    expect(result.attempt).toEqual(attempt);
    expect(calls).toHaveLength(0); // no /uploads, no second /finalize
    expect(puts).toHaveLength(0);
    expect(progress.at(-1)).toEqual({ phase: 'done', pagesDone: 2, pagesTotal: 2 });
  });

  it('a scan stopped on the server is reported calmly and never re-registered', async () => {
    const { api, calls } = fakeApi();
    const send: ApiClient['send'] = (method, path, body, schema) =>
      path === '/v1/assignments'
        ? Promise.resolve(schema.parse(state('cancelled')))
        : api.send(method, path, body, schema);
    const { io } = fakeIo();
    const error = await uploadScan({
      api: { ...api, send },
      io,
      pages: twoPages(),
      limits,
      attempt: { ...newAttempt(newKey), assignmentId: ASSIGNMENT },
      signal: new AbortController().signal,
      onProgress: () => undefined,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScanStoppedError);
    expect(calls).toHaveLength(0);
    expect(childUploadMessage(error)).toMatch(/still here.*new scan/);
  });

  it('reports a scan that is already being checked as too late to cancel', async () => {
    const { api } = fakeApi({
      fail: (call) =>
        call.path.endsWith('/cancel')
          ? new ApiRequestError('BUSINESS_RULE', 'x', 422, 'INVALID_TRANSITION')
          : null,
    });
    expect(await cancelScan(api, { ...newAttempt(newKey), assignmentId: ASSIGNMENT })).toBe(
      'too_late',
    );
  });
});

describe('child-facing error copy (spec P6, P14)', () => {
  it('maps every failure to calm words and never shows raw server text', () => {
    const rule = (r: string) => new ApiRequestError('BUSINESS_RULE', 'raw server text', 422, r);
    expect(childUploadMessage(new ApiRequestError('NETWORK', 'offline', 0))).toMatch(
      /offline.*still here/,
    );
    expect(childUploadMessage(rule('QUOTA_EXCEEDED'))).toMatch(/grown-up/);
    expect(childUploadMessage(rule('CONSENT_REQUIRED'))).toMatch(/grown-up/);
    expect(childUploadMessage(new ApiRequestError('UNAUTHENTICATED', 'x', 401))).toMatch(
      /connect this device/,
    );
    expect(childUploadMessage(new UploadTransferError(500))).toMatch(/didn’t finish sending/);
    expect(childUploadMessage(new ScanCancelledError())).toMatch(/Stopped/);
    expect(childUploadMessage(new Error('boom'))).toBe('Something went wrong. Let’s try again.');
    for (const e of [
      rule('QUOTA_EXCEEDED'),
      new ApiRequestError('INTERNAL', 'raw server text', 500),
    ]) {
      expect(childUploadMessage(e)).not.toContain('raw server text');
    }
    // No purchases or upsell in child copy (spec P11: never let a child buy usage).
    expect(childUploadMessage(rule('QUOTA_EXCEEDED'))).not.toMatch(/buy|purchase|upgrade|pay/i);
  });

  it('hex-encodes digests', () => {
    expect(toHex(new Uint8Array([0, 15, 255]))).toBe('000fff');
  });
});

describe('picture size and server capture rules (AC_CAPTURE_02)', () => {
  it('refuses a picture over the size limits before reading bytes or contacting the API', async () => {
    const { api, calls } = fakeApi();
    const read: string[] = [];
    const { io, puts } = fakeIo({
      readBytes: (uri) => {
        read.push(uri);
        return Promise.resolve(new TextEncoder().encode(`bytes of ${uri}`));
      },
    });
    const error = await uploadScan({
      api,
      io,
      pages: [
        toScanPage({ uri: 'file:///p1.jpg', mimeType: 'image/jpeg' }, 'camera', () => 'a'),
        toScanPage(
          { uri: 'file:///big.jpg', mimeType: 'image/jpeg', width: 16_320, height: 12_240 },
          'library',
          () => 'b',
        ),
      ],
      limits,
      attempt: newAttempt(newKey),
      signal: new AbortController().signal,
      onProgress: () => undefined,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PageLimitError);
    expect(error).toMatchObject({ pageNumber: 2, problem: 'too_many_pixels' });
    expect(childUploadMessage(error)).toBe(
      'Page 2 is too big a picture for PencilLift to read. Try taking a new photo of the page.',
    );
    expect(read).toEqual(['file:///p1.jpg']);
    expect(calls).toHaveLength(0);
    expect(puts).toHaveLength(0);
  });

  it('explains the server’s capture rules calmly, never with raw server text', () => {
    const rule = (r: string) => new ApiRequestError('BUSINESS_RULE', 'raw server text', 422, r);
    expect(childUploadMessage(rule('FORMAT_NOT_SUPPORTED_YET'))).toBe(
      'One page is a kind of file PencilLift can’t read yet. Try taking a photo of the page instead.',
    );
    expect(childUploadMessage(rule('UPLOAD_MISMATCH'))).toBe(
      'Some pages got mixed up on the way. Let’s try sending them again.',
    );
  });
});

describe('a scan too large to send together (R2C-MOB-2, SCAN_TOO_LARGE)', () => {
  const COPY = 'These pictures are too big to send together. Ask a grown-up to help.';

  it('gives the child its own words for the server’s SCAN_TOO_LARGE rule, never the generic line', () => {
    const error = new ApiRequestError('BUSINESS_RULE', 'raw server text', 422, 'SCAN_TOO_LARGE');
    expect(childUploadMessage(error)).toBe(COPY);
    expect(childUploadMessage(error)).not.toContain('raw server text');
  });

  it('refuses pages that add up to more than the scan bound before contacting the API', async () => {
    const { api, calls } = fakeApi();
    // Each page is under the per-page limit; together they are over HOMEWORK_SCAN_MAX_TOTAL_BYTES
    // (the fallback path, where the downscale failed and the original photo would be sent).
    const pageBytes = Math.floor(HOMEWORK_SCAN_MAX_TOTAL_BYTES / 2) + 1;
    expect(pageBytes).toBeLessThanOrEqual(limits.maxPageBytes);
    const { io, puts } = fakeIo({ readBytes: () => Promise.resolve(new Uint8Array(pageBytes)) });
    const error = await uploadScan({
      api,
      io,
      pages: twoPages(),
      limits,
      attempt: newAttempt(newKey),
      signal: new AbortController().signal,
      onProgress: () => undefined,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScanTooLargeError);
    expect(childUploadMessage(error)).toBe(COPY);
    expect(calls).toHaveLength(0);
    expect(puts).toHaveLength(0);
  });

  it('still sends pages that add up to exactly the bound', async () => {
    const { api, calls } = fakeApi();
    const pageBytes = HOMEWORK_SCAN_MAX_TOTAL_BYTES / 2;
    const { io, puts } = fakeIo({ readBytes: () => Promise.resolve(new Uint8Array(pageBytes)) });
    const result = await uploadScan({
      api,
      io,
      pages: twoPages(),
      limits,
      attempt: newAttempt(newKey),
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
    expect(result.assignment.status).toBe('queued');
    expect(calls.map((c) => c.path)).toEqual([
      '/v1/assignments',
      `/v1/assignments/${ASSIGNMENT}/uploads`,
      `/v1/assignments/${ASSIGNMENT}/finalize`,
    ]);
    expect(puts).toHaveLength(2);
  });
});

describe('stalled requests and memory (MOB-R1-03, MOB-R1-04)', () => {
  it('passes the scan’s AbortSignal to every API call so “Stop sending” can stop a stalled one', async () => {
    const controller = new AbortController();
    const signals: (AbortSignal | undefined)[] = [];
    const { api } = fakeApi();
    const send: ApiClient['send'] = (method, path, body, schema, options) => {
      signals.push(options?.signal);
      return api.send(method, path, body, schema, options);
    };
    const { io } = fakeIo();
    await uploadScan({
      api: { ...api, send },
      io,
      pages: twoPages(),
      limits,
      attempt: newAttempt(newKey),
      signal: controller.signal,
      onProgress: () => undefined,
    });
    expect(signals).toHaveLength(3);
    expect(signals.every((s) => s === controller.signal)).toBe(true);
  });

  it('an API call that fails because the scan was stopped is reported as cancelled', async () => {
    const controller = new AbortController();
    const { api } = fakeApi({
      fail: (call) => {
        if (call.path !== '/v1/assignments') return null;
        controller.abort();
        return new ApiRequestError('NETWORK', 'The request was stopped.', 0, 'ABORTED');
      },
    });
    const { io } = fakeIo();
    const error = await uploadScan({
      api,
      io,
      pages: twoPages(),
      limits,
      attempt: newAttempt(newKey),
      signal: controller.signal,
      onProgress: () => undefined,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScanCancelledError);
  });

  it('never holds every page’s bytes at once: fingerprints first, then re-reads each page just before its PUT', async () => {
    // Each read hands out a fresh buffer; a page's bytes are "live" from the read until the PUT
    // (or the fingerprint) that consumes them. More than one live page means the whole scan was
    // being pinned in memory (10 × 15 MB on a Fire tablet).
    const { api } = fakeApi();
    const live = new Set<Uint8Array>();
    let maxLive = 0;
    const order: string[] = [];
    const putBuffers: Uint8Array[] = [];
    const firstPass = new Map<string, Uint8Array>();
    const io: UploadIo = {
      readBytes: (uri) => {
        const bytes = new TextEncoder().encode(`bytes of ${uri}`);
        live.add(bytes);
        maxLive = Math.max(maxLive, live.size);
        order.push(`read ${uri}`);
        if (!firstPass.has(uri)) firstPass.set(uri, bytes);
        return Promise.resolve(bytes);
      },
      sha256Hex: (bytes) => {
        live.delete(bytes);
        order.push('hash');
        return Promise.resolve(toHex(bytes.slice(0, 32)).padEnd(64, '0'));
      },
      putBytes: (url, bytes) => {
        live.delete(bytes);
        putBuffers.push(bytes);
        order.push(`put ${url.replace(/\?.*$/, '')}`);
        return Promise.resolve();
      },
    };
    await uploadScan({
      api,
      io,
      pages: twoPages(),
      limits,
      attempt: newAttempt(newKey),
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
    expect(maxLive).toBe(1);
    expect(order).toEqual([
      'read file:///p1.jpg',
      'hash',
      'read file:///p2.png',
      'hash',
      'read file:///p1.jpg',
      'put https://storage.example.test/upload/1',
      'read file:///p2.png',
      'put https://storage.example.test/upload/2',
    ]);
    // The PUT sends the freshly read buffer, not one kept from the fingerprint pass.
    expect(putBuffers[0]).not.toBe(firstPass.get('file:///p1.jpg'));
  });

  it('a page already stored is not read again on resume', async () => {
    const reads: string[] = [];
    const { api } = fakeApi({ alreadyUploaded: [true, false] });
    const { io } = fakeIo({
      readBytes: (uri) => {
        reads.push(uri);
        return Promise.resolve(new TextEncoder().encode(`bytes of ${uri}`));
      },
    });
    await uploadScan({
      api,
      io,
      pages: twoPages(),
      limits,
      attempt: { ...newAttempt(newKey), assignmentId: ASSIGNMENT },
      signal: new AbortController().signal,
      onProgress: () => undefined,
    });
    expect(reads.filter((u) => u === 'file:///p1.jpg')).toHaveLength(1);
    expect(reads.filter((u) => u === 'file:///p2.png')).toHaveLength(2);
  });

  it('a page whose file changed between fingerprint and send is refused before the PUT', async () => {
    let reads = 0;
    const { api } = fakeApi();
    const { io, puts } = fakeIo({
      readBytes: (uri) => {
        reads += 1;
        // Second pass: the photo was replaced by a larger file.
        return Promise.resolve(
          new TextEncoder().encode(reads > 2 ? `changed bytes of ${uri}` : `bytes of ${uri}`),
        );
      },
    });
    const error = await uploadScan({
      api,
      io,
      pages: twoPages(),
      limits,
      attempt: newAttempt(newKey),
      signal: new AbortController().signal,
      onProgress: () => undefined,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UploadTransferError);
    expect(puts).toHaveLength(0);
  });
});

/**
 * HUNT4-MOB-5. cancelScan already computes three outcomes so the caller can tell the child the
 * truth, but the abort path threw the value away: it always said "Stopped. Your pages are still
 * here." and rotated the idempotency keys. When the child taps "Stop sending" during the finalize
 * round trip, the server may have committed the finalize and the scan job may have moved the
 * assignment out of 'queued', so the cancel is refused INVALID_TRANSITION ('too_late'). The child was
 * then told the scan had stopped while it was being checked and charged, and with fresh keys "Try
 * again" created a SECOND assignment for the same homework — two jobs and two page-allowance charges
 * against AC_CAPTURE_06's one job, one charge.
 */
describe('a scan the child stopped too late is not reported as stopped (HUNT4-MOB-5)', () => {
  it('[repro] keeps the same attempt and says the scan was already sent', () => {
    const outcome = stoppedScanOutcome('too_late');
    // Same attempt: "Try again" re-creates with the SAME createKey, which the server answers with
    // the assignment it already has instead of a second one.
    expect(outcome.keepAttempt).toBe(true);
    expect(outcome.message).toMatch(/already sent/i);
    expect(outcome.message).not.toMatch(/stopped/i);
  });

  it('a scan that really was stopped keeps the calm "Stopped" copy and a fresh attempt', () => {
    for (const cancel of ['cancelled', 'nothing_to_cancel'] as const) {
      const outcome = stoppedScanOutcome(cancel);
      expect(outcome.keepAttempt).toBe(false);
      expect(outcome.message).toBe(childUploadMessage(new ScanCancelledError()));
    }
  });

  it('never offers a purchase or shows raw server text (spec P11, P14)', () => {
    for (const cancel of ['cancelled', 'nothing_to_cancel', 'too_late'] as const) {
      expect(stoppedScanOutcome(cancel).message).not.toMatch(/buy|purchase|upgrade|pay/i);
    }
  });
});
