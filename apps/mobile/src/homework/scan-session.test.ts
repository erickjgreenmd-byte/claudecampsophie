import { describe, expect, it } from 'vitest';
import { DEFAULT_HOMEWORK_UPLOAD_LIMITS } from '@pencillift/contracts';
import {
  EMPTY_SESSION,
  addPages,
  canSend,
  describeSize,
  inferMimeType,
  limitsSummary,
  movePage,
  problemCopy,
  remainingSlots,
  removePage,
  replacePage,
  toScanPage,
  validateSession,
  type PickedAsset,
  type ScanPage,
} from './scan-session.ts';

const limits = DEFAULT_HOMEWORK_UPLOAD_LIMITS;
let counter = 0;
const newId = () => `local-${(counter += 1)}`;

function photo(overrides: Partial<PickedAsset> = {}): PickedAsset {
  return {
    uri: `file:///cache/photo-${counter}.jpg`,
    mimeType: 'image/jpeg',
    fileSize: 500_000,
    ...overrides,
  };
}

function pagesOf(n: number): ScanPage[] {
  return Array.from({ length: n }, () => toScanPage(photo(), 'camera', newId));
}

describe('limits are shown before anything is uploaded (spec P5)', () => {
  it('summarizes the configured limits in plain words', () => {
    expect(limitsSummary(limits)).toBe(
      'Up to 10 pages per scan. Each page can be up to 15 MB. Photos (JPEG, PNG or HEIC) or a PDF.',
    );
    expect(
      limitsSummary({
        maxPages: 3,
        maxPageBytes: 5 * 1024 * 1024,
        allowedMimeTypes: ['image/png'],
      }),
    ).toBe('Up to 3 pages per scan. Each page can be up to 5 MB. Photos (PNG).');
  });

  it('formats sizes for people', () => {
    expect(describeSize(1536)).toBe('2 KB');
    expect(describeSize(2.5 * 1024 * 1024)).toBe('2.5 MB');
  });
});

describe('page types', () => {
  it('uses the declared type or infers it from the file name', () => {
    expect(inferMimeType({ uri: 'file:///a.JPG' })).toBe('image/jpeg');
    expect(inferMimeType({ uri: 'file:///a', fileName: 'scan.heif' })).toBe('image/heic');
    expect(inferMimeType({ uri: 'file:///a', mimeType: 'image/jpg' })).toBe('image/jpeg');
    expect(inferMimeType({ uri: 'file:///a.pdf' })).toBe('application/pdf');
    expect(inferMimeType({ uri: 'file:///a.gif' })).toBe('image/gif');
    expect(inferMimeType({ uri: 'file:///noext' })).toBe('application/octet-stream');
  });
});

describe('building a scan', () => {
  it('adds pages in order and never beyond the page limit', () => {
    const first = addPages(EMPTY_SESSION, pagesOf(8), limits);
    expect(first.session.pages).toHaveLength(8);
    expect(first.dropped).toBe(0);
    expect(remainingSlots(first.session, limits)).toBe(2);
    const more = addPages(first.session, pagesOf(4), limits);
    expect(more.session.pages).toHaveLength(10);
    expect(more.dropped).toBe(2);
    expect(remainingSlots(more.session, limits)).toBe(0);
  });

  it('reorders, replaces and removes pages', () => {
    const [a, b, c] = pagesOf(3) as [ScanPage, ScanPage, ScanPage];
    let session = addPages(EMPTY_SESSION, [a, b, c], limits).session;
    session = movePage(session, c.localId, -1);
    expect(session.pages.map((p) => p.localId)).toEqual([a.localId, c.localId, b.localId]);
    session = movePage(session, a.localId, -1); // already first: unchanged
    expect(session.pages[0]!.localId).toBe(a.localId);
    session = movePage(session, b.localId, 1); // already last: unchanged
    expect(session.pages[2]!.localId).toBe(b.localId);
    session = replacePage(session, c.localId, { uri: 'file:///rotated.jpg', byteSize: null });
    expect(session.pages[1]).toMatchObject({ localId: c.localId, uri: 'file:///rotated.jpg' });
    session = removePage(session, a.localId);
    expect(session.pages.map((p) => p.localId)).toEqual([c.localId, b.localId]);
  });
});

describe('validation before upload (AC_CAPTURE_02)', () => {
  it('needs at least one page', () => {
    expect(validateSession(EMPTY_SESSION, limits)).toEqual([{ kind: 'no_pages' }]);
    expect(canSend(EMPTY_SESSION, limits)).toBe(false);
  });

  it('flags unsupported types and oversized pages per page, with child-friendly copy', () => {
    const gif = toScanPage(photo({ mimeType: 'image/gif' }), 'library', newId);
    const huge = toScanPage(photo({ fileSize: 16 * 1024 * 1024 }), 'library', newId);
    const ok = toScanPage(photo(), 'camera', newId);
    const session = addPages(EMPTY_SESSION, [ok, gif, huge], limits).session;
    const problems = validateSession(session, limits);
    expect(problems).toEqual([
      { kind: 'page', localId: gif.localId, pageNumber: 2, problem: 'unsupported_type' },
      { kind: 'page', localId: huge.localId, pageNumber: 3, problem: 'too_large' },
    ]);
    expect(canSend(session, limits)).toBe(false);
    expect(problems.map((p) => problemCopy(p, limits))).toEqual([
      'Page 2 is a kind of file PencilLift can’t read. Try a photo or a PDF instead.',
      'Page 3 is too big (over 15 MB). Try taking the photo again.',
    ]);
  });

  it('accepts pages whose size is not known yet (checked again when the bytes are read)', () => {
    const fromCamera = toScanPage(
      { uri: 'file:///cam.jpg', mimeType: 'image/jpeg' },
      'camera',
      newId,
    );
    const session = addPages(EMPTY_SESSION, [fromCamera], limits).session;
    expect(validateSession(session, limits)).toEqual([]);
    expect(canSend(session, limits)).toBe(true);
  });

  it('flags too many pages if limits shrink after pages were added', () => {
    const session = addPages(EMPTY_SESSION, pagesOf(5), limits).session;
    const tighter = { ...limits, maxPages: 3 };
    expect(validateSession(session, tighter)).toEqual([{ kind: 'too_many_pages', max: 3 }]);
    expect(problemCopy({ kind: 'too_many_pages', max: 3 }, tighter)).toBe(
      'Only 3 pages fit in one scan. Remove a page or two.',
    );
  });
});
