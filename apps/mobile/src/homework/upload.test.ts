import { describe, expect, it } from 'vitest';
import { DEFAULT_HOMEWORK_UPLOAD_LIMITS } from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { toScanPage, type ScanPage } from './scan-session.ts';
import {
  ScanCancelledError,
  ScanStoppedError,
  UploadTransferError,
  cancelScan,
  childUploadMessage,
  newAttempt,
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
      { uri: 'file:///p2.pdf', mimeType: 'application/pdf', fileSize: 1000 },
      'pdf',
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
      [2, 'application/pdf'],
    ]);
    expect(registered.every((p) => /^[0-9a-f]{64}$/.test(p.sha256 as string))).toBe(true);
    expect(calls[2]!.body).toEqual({ idempotencyKey: attempt.finalizeKey });
    expect(puts.map((p) => p.mimeType)).toEqual(['image/jpeg', 'application/pdf']);
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
