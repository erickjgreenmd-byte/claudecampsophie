/**
 * Child scan session (spec P5 capture; AC_CAPTURE_01/02): the pages a child has picked, their order,
 * and validation against the upload limits, which are shown before anything is sent.
 *
 * Pure logic with no react-native imports so it is unit-testable; the scan screen wires the camera,
 * photo library and document picker to it.
 */
import type { HomeworkMimeType, HomeworkUploadLimits } from '@pencillift/contracts';

export type PageSource = 'camera' | 'library' | 'pdf';

export interface ScanPage {
  readonly localId: string;
  readonly uri: string;
  /** Declared or inferred type; checked against the allowed list before upload. */
  readonly mimeType: string;
  /** Null when the picker did not report a size (it is measured when the bytes are read). */
  readonly byteSize: number | null;
  readonly source: PageSource;
}

/** What the camera, image picker and document picker hand back (subset). */
export interface PickedAsset {
  readonly uri: string;
  readonly mimeType?: string | null;
  readonly fileName?: string | null;
  readonly fileSize?: number | null;
}

export interface ScanSession {
  readonly pages: readonly ScanPage[];
}

export const EMPTY_SESSION: ScanSession = { pages: [] };

const MIME_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/heif': 'image/heic',
};

const EXTENSION_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  heif: 'image/heic',
  pdf: 'application/pdf',
  gif: 'image/gif',
  webp: 'image/webp',
};

export function inferMimeType(asset: PickedAsset): string {
  const declared = asset.mimeType?.trim().toLowerCase();
  if (declared) return MIME_ALIASES[declared] ?? declared;
  const name = asset.fileName ?? asset.uri.split('?')[0] ?? '';
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return (ext && EXTENSION_TYPES[ext]) ?? 'application/octet-stream';
}

export function toScanPage(asset: PickedAsset, source: PageSource, newId: () => string): ScanPage {
  const size = asset.fileSize;
  return {
    localId: newId(),
    uri: asset.uri,
    mimeType: inferMimeType(asset),
    byteSize: typeof size === 'number' && size > 0 ? size : null,
    source,
  };
}

export function remainingSlots(session: ScanSession, limits: HomeworkUploadLimits): number {
  return Math.max(0, limits.maxPages - session.pages.length);
}

/** Adds pages up to the page limit; `dropped` tells the screen how many did not fit. */
export function addPages(
  session: ScanSession,
  pages: readonly ScanPage[],
  limits: HomeworkUploadLimits,
): { session: ScanSession; dropped: number } {
  const room = remainingSlots(session, limits);
  const accepted = pages.slice(0, room);
  return {
    session: { pages: [...session.pages, ...accepted] },
    dropped: pages.length - accepted.length,
  };
}

export function removePage(session: ScanSession, localId: string): ScanSession {
  return { pages: session.pages.filter((p) => p.localId !== localId) };
}

/** Moves a page one place earlier (-1) or later (+1); ends are left unchanged. */
export function movePage(session: ScanSession, localId: string, direction: -1 | 1): ScanSession {
  const index = session.pages.findIndex((p) => p.localId === localId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= session.pages.length) return session;
  const pages = [...session.pages];
  [pages[index], pages[target]] = [pages[target]!, pages[index]!];
  return { pages };
}

/** Replaces a page's file (retake or rotate) while keeping its place in the order. */
export function replacePage(
  session: ScanSession,
  localId: string,
  change: Partial<Pick<ScanPage, 'uri' | 'mimeType' | 'byteSize'>>,
): ScanSession {
  return { pages: session.pages.map((p) => (p.localId === localId ? { ...p, ...change } : p)) };
}

export type PageProblem = 'unsupported_type' | 'too_large';

export type SessionProblem =
  | { readonly kind: 'no_pages' }
  | { readonly kind: 'too_many_pages'; readonly max: number }
  | {
      readonly kind: 'page';
      readonly localId: string;
      readonly pageNumber: number;
      readonly problem: PageProblem;
    };

export function isAllowedType(mimeType: string, limits: HomeworkUploadLimits): boolean {
  return (limits.allowedMimeTypes as readonly string[]).includes(mimeType);
}

export function validateSession(
  session: ScanSession,
  limits: HomeworkUploadLimits,
): SessionProblem[] {
  if (session.pages.length === 0) return [{ kind: 'no_pages' }];
  const problems: SessionProblem[] = [];
  if (session.pages.length > limits.maxPages) {
    problems.push({ kind: 'too_many_pages', max: limits.maxPages });
  }
  session.pages.forEach((page, i) => {
    const base = { kind: 'page' as const, localId: page.localId, pageNumber: i + 1 };
    if (!isAllowedType(page.mimeType, limits)) {
      problems.push({ ...base, problem: 'unsupported_type' });
    } else if (page.byteSize !== null && page.byteSize > limits.maxPageBytes) {
      problems.push({ ...base, problem: 'too_large' });
    }
  });
  return problems;
}

export function canSend(session: ScanSession, limits: HomeworkUploadLimits): boolean {
  return validateSession(session, limits).length === 0;
}

export function describeSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

const TYPE_NAMES: Record<HomeworkMimeType, string> = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/heic': 'HEIC',
  'application/pdf': 'PDF',
};

function joinOr(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]!}`;
}

/** Plain-language limits shown on the scan screen before anything is picked or sent. */
export function limitsSummary(limits: HomeworkUploadLimits): string {
  const photos = limits.allowedMimeTypes.filter((t) => t !== 'application/pdf');
  const kinds: string[] = [];
  if (photos.length > 0) kinds.push(`Photos (${joinOr(photos.map((t) => TYPE_NAMES[t]))})`);
  if (limits.allowedMimeTypes.includes('application/pdf')) kinds.push('a PDF');
  return (
    `Up to ${limits.maxPages} pages per scan. ` +
    `Each page can be up to ${describeSize(limits.maxPageBytes)}. ` +
    `${joinOr(kinds)}.`
  );
}

/** Calm, blame-free copy for the child (spec P6/P14). */
export function problemCopy(problem: SessionProblem, limits: HomeworkUploadLimits): string {
  switch (problem.kind) {
    case 'no_pages':
      return 'Add a page to get started.';
    case 'too_many_pages':
      return `Only ${problem.max} pages fit in one scan. Remove a page or two.`;
    case 'page':
      return problem.problem === 'unsupported_type'
        ? `Page ${problem.pageNumber} is a kind of file PencilLift can’t read. Try a photo or a PDF instead.`
        : `Page ${problem.pageNumber} is too big (over ${describeSize(limits.maxPageBytes)}). Try taking the photo again.`;
  }
}
