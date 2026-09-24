import { Hono } from 'hono';
import { uuidSchema } from '@pencillift/contracts';
import { ApiError } from '../errors.ts';
import { assertRecentUnlock, currentFamilyId, requireParent } from '../middleware/auth.ts';
import type { AppEnv } from '../middleware/context.ts';

/** Signed download links live one minute: long enough to start the download, too short to share. */
const DOWNLOAD_URL_SECONDS = 60;

/**
 * The one export a child may be handed on a shared device: the printable practice questions, which
 * never contain answers or other children's data. Every other kind holds private family data.
 */
const CHILD_SAFE_EXPORT_KINDS: ReadonlySet<string> = new Set(['review_questions_pdf']);

/**
 * Download of a finished export (spec P3 "recent reauthentication server-side for ... exports",
 * P4 export, P8 "answer-key export requires recent parent reauthentication and a distinct
 * protected route"). Parent only, own family only, and a recent adult unlock for every kind except
 * the child-safe questions sheet (RV-lead-identity-access-3). The file itself stays in private
 * storage; the response is a short-lived signed URL, never the bytes or a durable link.
 */
export function exportDownloadRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get('/exports/:id/download', requireParent, async (c) => {
    const { deps } = c.var;
    const id = uuidSchema.safeParse(c.req.param('id'));
    if (!id.success) throw new ApiError('NOT_FOUND', 'Export not found');
    const familyId = await currentFamilyId(c);
    // Service role bypasses RLS, so family ownership is part of the query (spec E4).
    const [row] = await deps.db.asService(
      (tx) => tx<
        { kind: string; status: string; storage_path: string | null; expires_at: Date | null }[]
      >`
        select kind, status, storage_path, expires_at from public.data_exports
         where id = ${id.data} and family_id = ${familyId}
      `,
    );
    if (!row) throw new ApiError('NOT_FOUND', 'Export not found');
    if (!CHILD_SAFE_EXPORT_KINDS.has(row.kind)) await assertRecentUnlock(c);
    const now = deps.clock();
    if (row.status !== 'ready' || !row.storage_path) {
      throw new ApiError('CONFLICT', 'This export is not ready yet');
    }
    if (row.expires_at && row.expires_at <= now) {
      throw new ApiError('CONFLICT', 'This export has expired; request a new one');
    }
    const signed = await deps.providers.storage.createSignedReadUrl(
      row.storage_path,
      DOWNLOAD_URL_SECONDS,
    );
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    return c.json({ url: signed.url, expiresAt: signed.expiresAt.toISOString() });
  });

  return r;
}
