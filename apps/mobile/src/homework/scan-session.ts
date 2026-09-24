/**
 * Child scan session (spec P5 capture; AC_CAPTURE_01/02): the pages a child has picked, their order,
 * and validation against the upload limits, which are shown before anything is sent.
 *
 * Pure logic with no react-native imports so it is unit-testable; the scan screen wires the camera
 * and photo library to it. PDF import is not offered: the scan job cannot read PDF (or HEIC) until
 * the isolated converter ships, and such a scan would always end failed_final
 * FORMAT_NEEDS_CONVERSION. Photos are re-encoded to JPEG on the device, so a HEIC photo is sent as
 * JPEG; one that could not be re-encoded is flagged here instead of being sent.
 *
 * Picture size (AC_CAPTURE_02): the camera and picker report width and height, which are checked
 * against the same HOMEWORK_IMAGE_LIMITS the scan job applies, and shown in `limitsSummary`. An
 * over-limit picture is flagged so it cannot be sent, and the app skips its own re-encode of it
 * (`isOversizedPicture`). That saves a second decode only: the image picker has usually decoded it
 * already (expo-image-picker re-compresses when quality < 1), so this is a courtesy to the user, not
 * a defence. The defence is the scan job, which refuses any page whose header is over the limits
 * before anything is decoded or sent to AI; an unknown size therefore passes here.
 */
import {
  HOMEWORK_IMAGE_LIMITS,
  HOMEWORK_READABLE_MIME_TYPES,
  homeworkImageSizeProblem,
  type HomeworkMimeType,
  type HomeworkUploadLimits,
} from '@pencillift/contracts';

export type PageSource = 'camera' | 'library';

export interface ScanPage {
  readonly localId: string;
  readonly uri: string;
  /** Declared or inferred type; checked against the allowed list before upload. */
  readonly mimeType: string;
  /** Null when the picker did not report a size (it is measured when the bytes are read). */
  readonly byteSize: number | null;
  readonly source: PageSource;
  /** Pixel size as the camera or picker reported it; null (or absent) when unknown. */
  readonly width?: number | null;
  readonly height?: number | null;
}

/** What the camera and image picker hand back (subset). */
export interface PickedAsset {
  readonly uri: string;
  readonly mimeType?: string | null;
  readonly fileName?: string | null;
  readonly fileSize?: number | null;
  readonly width?: number | null;
  readonly height?: number | null;
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

const positive = (n: number | null | undefined): number | null =>
  typeof n === 'number' && n > 0 ? n : null;

export function toScanPage(asset: PickedAsset, source: PageSource, newId: () => string): ScanPage {
  return {
    localId: newId(),
    uri: asset.uri,
    mimeType: inferMimeType(asset),
    byteSize: positive(asset.fileSize),
    source,
    width: positive(asset.width),
    height: positive(asset.height),
  };
}

/** True when a reported pixel size is over the limits; false when it is fine or unknown. */
function overPictureLimits(width: number | null | undefined, height: number | null | undefined) {
  const w = positive(width);
  const h = positive(height);
  return w !== null && h !== null && homeworkImageSizeProblem(w, h) === 'too_large';
}

/**
 * The screen asks this before re-encoding a picked photo: a picture over the size limits is added
 * as is (no second decode on the device), so its page shows the problem and cannot be sent.
 */
export function isOversizedPicture(asset: PickedAsset): boolean {
  return overPictureLimits(asset.width, asset.height);
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
  change: Partial<Pick<ScanPage, 'uri' | 'mimeType' | 'byteSize' | 'width' | 'height'>>,
): ScanSession {
  return { pages: session.pages.map((p) => (p.localId === localId ? { ...p, ...change } : p)) };
}

/** `too_large`: bytes over the page limit. `too_many_pixels`: picture over the size limits. */
export type PageProblem = 'unsupported_type' | 'too_large' | 'too_many_pixels';

export type SessionProblem =
  | { readonly kind: 'no_pages' }
  | { readonly kind: 'too_many_pages'; readonly max: number }
  | {
      readonly kind: 'page';
      readonly localId: string;
      readonly pageNumber: number;
      readonly problem: PageProblem;
    };

/** Types the app sends: allowed by the server's limits and readable by the scan job today. */
export function readableTypes(limits: HomeworkUploadLimits): HomeworkMimeType[] {
  return limits.allowedMimeTypes.filter((t) => HOMEWORK_READABLE_MIME_TYPES.includes(t));
}

export function isAllowedType(mimeType: string, limits: HomeworkUploadLimits): boolean {
  return (readableTypes(limits) as readonly string[]).includes(mimeType);
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
    } else if (isPictureTooBig(page)) {
      problems.push({ ...base, problem: 'too_many_pixels' });
    }
  });
  return problems;
}

/** A page whose reported pixel size is over HOMEWORK_IMAGE_LIMITS (unknown sizes pass). */
export function isPictureTooBig(page: ScanPage): boolean {
  return overPictureLimits(page.width, page.height);
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

/**
 * Plain-language limits shown on the scan screen before anything is picked or sent. Lists only the
 * photo types the scan job reads today, and says honestly when PDF import isn't available yet.
 */
export function limitsSummary(limits: HomeworkUploadLimits): string {
  const photos = readableTypes(limits);
  const parts = [
    `Up to ${limits.maxPages} pages per scan.`,
    `Each page can be up to ${describeSize(limits.maxPageBytes)}.`,
  ];
  if (photos.length > 0) {
    const megapixels = HOMEWORK_IMAGE_LIMITS.maxPixels / 1_000_000;
    parts.push(
      `Photos (${joinOr(photos.map((t) => TYPE_NAMES[t]))}) of up to ${megapixels} megapixels.`,
    );
  }
  if (limits.allowedMimeTypes.includes('application/pdf') && !photos.includes('application/pdf')) {
    parts.push('PDF files can’t be added yet, so take a photo of each page instead.');
  }
  return parts.join(' ');
}

/** Shared with upload.ts so the same problem always reads the same way. */
export function pictureTooBigCopy(pageNumber: number): string {
  return `Page ${pageNumber} is too big a picture for PencilLift to read. Try taking a new photo of the page.`;
}

/** Calm, blame-free copy for the child (spec P6/P14). */
export function problemCopy(problem: SessionProblem, limits: HomeworkUploadLimits): string {
  switch (problem.kind) {
    case 'no_pages':
      return 'Add a page to get started.';
    case 'too_many_pages':
      return `Only ${problem.max} pages fit in one scan. Remove a page or two.`;
    case 'page':
      switch (problem.problem) {
        case 'unsupported_type':
          return `Page ${problem.pageNumber} is a kind of file PencilLift can’t read yet. Try taking a photo of the page instead.`;
        case 'too_large':
          return `Page ${problem.pageNumber} is too big (over ${describeSize(limits.maxPageBytes)}). Try taking the photo again.`;
        case 'too_many_pixels':
          return pictureTooBigCopy(problem.pageNumber);
      }
  }
}
