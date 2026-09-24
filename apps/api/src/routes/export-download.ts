import { Hono } from 'hono';
import { uuidSchema } from '@pencillift/contracts';
import { ApiError } from '../errors.ts';
import { assertRecentUnlock, currentFamilyId, requireParent } from '../middleware/auth.ts';
import type { AppEnv } from '../middleware/context.ts';

/** Signed download links live one minute: long enough to start the download, too short to share. */
const DOWNLOAD_URL_SECONDS = 60;

/**
 * Download of a finished export (spec P4 export, P8 "answer-key export requires recent parent
 * reauthentication and a distinct protected route"). Parent only, own family only; the answer-key
 * kind additionally needs a recent adult unlock. The file itself stays in private storage; the
 * response is a short-lived signed URL, never the bytes or a durable link.
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
    if (row.kind === 'review_answer_key_pdf') await assertRecentUnlock(c);
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
