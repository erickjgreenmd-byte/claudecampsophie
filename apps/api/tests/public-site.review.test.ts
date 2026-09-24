import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockModerationClient, createMockResponsesClient } from '@pencillift/ai';
import { cryptoRandom } from '@pencillift/domain';
import { seedFamily } from '@pencillift/db/testing/fixtures';
import { runJobs, type JobDeps } from '../src/jobs/dispatcher.ts';
import { createScanProcessHandler } from '../src/jobs/scan-process.ts';
import { createTestApi, type TestApi } from './helpers.ts';

/**
 * Independent review of the public-site vertical (REVIEW-PUBLIC-SITE). These probes check that the
 * public privacy draft (apps/web/src/pages/public/PrivacyPage.tsx) describes what the implemented
 * scan pipeline actually does. LABELED MOCK AI client; synthetic bytes only, no real homework.
 */

let api: TestApi;
let deps: JobDeps;

beforeAll(async () => {
  api = await createTestApi();
  deps = {
    db: api.apiDb,
    config: api.config,
    clock: () => api.now.value,
    random: cryptoRandom,
    providers: api.providers,
    log: (e) => api.logs.push(e),
  };
});

afterAll(async () => {
  await api?.close();
});

/**
 * A synthetic JPEG whose APP1 segment is an Exif block carrying a GPS IFD pointer (tag 0x8825),
 * which is how phones record where a photo was taken.
 */
function jpegWithExifGps(): Uint8Array {
  const exifPayload = Buffer.concat([
    Buffer.from('Exif\0\0', 'binary'),
    // TIFF header (big endian), IFD0 offset 8, 1 entry: GPSInfo tag 0x8825, LONG x1 -> offset 26, next IFD 0
    Buffer.from(
      ['4d4d002a', '00000008', '0001', '8825', '0004', '00000001', '0000001a', '00000000'].join(''),
      'hex',
    ),
    // GPS IFD with zero entries (enough to prove the segment survives)
    Buffer.from('000000000000', 'hex'),
  ]);
  const length = exifPayload.length + 2;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from('ffd8', 'hex'), // SOI
      Buffer.from([0xff, 0xe1, (length >> 8) & 0xff, length & 0xff]), // APP1 marker + length
      exifPayload,
      Buffer.from([0xff, 0xdb, 0x00, 0x43, 0x00, ...new Array<number>(64).fill(1)]), // DQT
      Buffer.from([0xff, 0xc0, 0x00, 0x0b, 8, 0, 1, 0, 1, 1, 1, 0x11, 0]), // SOF0: 1 x 1 pixel
      Buffer.from([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0, 0x12, 0x34]), // SOS + scan data
      Buffer.from('ffd9', 'hex'), // EOI
    ]),
  );
}

function hasExifSegment(bytes: Uint8Array): boolean {
  for (let i = 0; i + 9 < bytes.length; i++) {
    if (
      bytes[i] === 0xff &&
      bytes[i + 1] === 0xe1 &&
      Buffer.from(bytes.subarray(i + 4, i + 8)).toString('binary') === 'Exif'
    ) {
      return true;
    }
  }
  return false;
}

async function queuedSinglePageScan() {
  const fam = await seedFamily(api.db, { childCount: 1 });
  await api.db.sql`
    insert into public.consent_records (family_id, adult_user_id, provider, method, purpose, policy_version, status, is_test_provider, verified_at)
    values (${fam.familyId}, ${fam.ownerId}, 'mock', 'mock', 'child_learning_data', 'v1', 'verified', true, now())`;
  const childId = fam.children[0]!.id;
  const [a] = await api.db.sql<{ id: string }[]>`
    insert into public.assignments (family_id, child_id, idempotency_key, created_by_kind, page_count, status)
    values (${fam.familyId}, ${childId}, ${'scan-' + randomUUID()}, 'child', 1, 'queued') returning id`;
  const pageId = randomUUID();
  await api.db.sql`
    insert into public.source_pages (id, assignment_id, family_id, child_id, page_number, storage_path, mime_type, byte_size, sha256)
    values (${pageId}, ${a!.id}, ${fam.familyId}, ${childId}, 1, ${`${fam.familyId}/${childId}/${a!.id}/${pageId}.jpg`},
            'image/jpeg', ${jpegWithExifGps().length},
            ${createHash('sha256').update(jpegWithExifGps()).digest('hex')}) -- lead fixture update: registered bytes = stored bytes (stored-page integrity)
    `;
  const [r] = await api.db.sql<{ id: string }[]>`
    insert into public.usage_reservations (family_id, child_id, period_key, units, idempotency_key)
    values (${fam.familyId}, ${childId}, '2026-09', 1, ${`scan-usage:${a!.id}:v1`}) returning id`;
  await api.db.sql`
    insert into public.jobs (kind, idempotency_key, family_id, child_id, payload, max_attempts, run_after)
    values ('scan_process', ${`scan:${a!.id}:v1`}, ${fam.familyId}, ${childId},
            ${JSON.stringify({ assignmentId: a!.id, mode: 'initial', reservationId: r!.id })}::text::jsonb,
            5, ${new Date(api.now.value.getTime() - 1000)})`;
}

describe('public-site review: privacy draft vs the implemented scan pipeline', () => {
  it('[RV-public-site-1] location/camera metadata is removed from homework photos before AI processing (PrivacyPage claim, spec P4)', async () => {
    await queuedSinglePageScan();
    const stored = jpegWithExifGps();
    expect(hasExifSegment(stored)).toBe(true); // sanity: the fixture really carries Exif/GPS

    // LABELED MOCK: records the request, then reports a retryable provider outage.
    const client = createMockResponsesClient(() => ({
      kind: 'error',
      status: 503,
      retryable: true,
      latencyMs: 1,
      timedOut: false,
    }));
    await runJobs(deps, {
      scan_process: createScanProcessHandler({
        ai: client,
        moderation: createMockModerationClient(),
        readObject: () => Promise.resolve(stored),
        sleep: () => Promise.resolve(),
      }),
    });

    const extraction = client.requests.find((r) => r.outputName === 'homework_extraction');
    expect(extraction, 'the scan reached the AI extraction stage').toBeDefined();
    const images = extraction!.input.filter((p) => p.type === 'input_image');
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      if (image.type !== 'input_image') continue;
      const sent = new Uint8Array(
        Buffer.from(image.image_url.replace(/^data:image\/\w+;base64,/, ''), 'base64'),
      );
      // PrivacyPage: "Location and camera details are removed from photos before they are
      // processed." and "PencilLift does not collect precise location."
      expect(hasExifSegment(sent), 'Exif/GPS segment was forwarded to the AI provider').toBe(false);
    }
  });
});
