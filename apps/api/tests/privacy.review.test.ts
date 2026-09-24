// Independent adversarial review of the privacy vertical (REVIEW-PRIVACY, fresh context).
// Findings are named "[RV-privacy-<n>]" and fail against the reviewed code for the stated reason;
// "probe:" tests pin the riskiest behaviour that held up. Real Postgres; synthetic data only
// (Riley, Sam). Spec: P3, P4, P8, P10, P14, E4 Deletion; AC_ACCESS_10, AC_SECURITY_01, AC_SECURITY_05.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  dataExportResponseSchema,
  deletionRequestResponseSchema,
  deletionRequestsResponseSchema,
} from '@pencillift/contracts';
import { cryptoRandom } from '@pencillift/domain';
import { grantAdultUnlock, seedFamily, type SeededFamily } from '@pencillift/db/testing/fixtures';
import { deletionPurgeHandler, type JobDeps, type JobRow } from '../src/jobs/dispatcher.ts';
import { createExportBuildHandler } from '../src/jobs/export-build.ts';
import { createTestApi, json, parentToken, type TestApi } from './helpers.ts';

let api: TestApi;

beforeAll(async () => {
  api = await createTestApi();
});

afterAll(async () => {
  await api?.close();
});

function jobDeps(): JobDeps {
  return {
    db: api.apiDb,
    config: api.config,
    clock: () => api.now.value,
    random: cryptoRandom,
    providers: api.providers,
    log: () => undefined,
  };
}

async function unlockedFamily(childCount = 1): Promise<{ family: SeededFamily; token: string }> {
  const family = await seedFamily(api.db, { childCount });
  const sessionId = randomUUID();
  await grantAdultUnlock(api.db, family.ownerId, sessionId, 3600);
  return { family, token: await parentToken(family.ownerId, { sessionId }) };
}

/** Adds an active, unlocked guardian to the family; returns their id, session and token. */
async function unlockedGuardian(
  family: SeededFamily,
): Promise<{ userId: string; sessionId: string; token: string }> {
  const userId = await api.db.createUser();
  await api.db.sql`
    insert into public.family_memberships (family_id, user_id, role, invited_by)
    values (${family.familyId}, ${userId}, 'guardian', ${family.ownerId})`;
  const sessionId = randomUUID();
  await grantAdultUnlock(api.db, userId, sessionId, 3600);
  return { userId, sessionId, token: await parentToken(userId, { sessionId }) };
}

/** Private export files "uploaded" by the builder, keyed by storage path (labeled test double). */
const uploaded = new Map<string, string>();
const buildExport = createExportBuildHandler({
  upload: (path, bytes) => {
    uploaded.set(path, new TextDecoder().decode(bytes));
    api.providers.storage.objects.add(path);
    return Promise.resolve();
  },
});

async function jobByKey(key: string): Promise<JobRow> {
  const [job] = await api.db.sql<JobRow[]>`
    select id, kind, family_id, child_id, payload, attempts, max_attempts
      from public.jobs where idempotency_key = ${key}`;
  expect(job).toBeDefined();
  return job!;
}

/** Runs the real export builder for one export (what the scheduled tick does). */
async function runExportBuild(exportId: string): Promise<void> {
  await buildExport(jobDeps(), await jobByKey('export:' + exportId));
}

/** Runs the real deletion purge job for one deletion request. */
async function runPurge(deletionId: string): Promise<void> {
  await deletionPurgeHandler(jobDeps(), await jobByKey('deletion:' + deletionId));
}

async function requestExport(token: string, body: unknown): Promise<Response> {
  return api.request('/v1/exports', { method: 'POST', token, body });
}

async function requestDeletion(token: string, body: unknown): Promise<Response> {
  return api.request('/v1/deletion', { method: 'POST', token, body });
}

async function exportRow(
  exportId: string,
): Promise<{ status: string; storage_path: string | null } | undefined> {
  const [row] = await api.db.sql<{ status: string; storage_path: string | null }[]>`
    select status, storage_path from public.data_exports where id = ${exportId}`;
  return row;
}

describe('privacy review findings', () => {
  it('[RV-privacy-1] a guardian cannot bypass the owner-only family deletion by calling request_deletion directly', async () => {
    // Spec P3: "Permissions are enforced at API, database and storage layers"; E4: "Test actual
    // database/storage permissions and direct API requests; UI hiding is insufficient." The API
    // refuses a guardian's family deletion (OWNER_ONLY_FAMILY_DELETION), but public.request_deletion
    // is granted to `authenticated` (PostgREST-exposed with the parent's own Supabase JWT) and does
    // not check the owner role.
    const { family } = await unlockedFamily(1);
    const guardian = await unlockedGuardian(family);

    const viaApi = await requestDeletion(guardian.token, { scope: 'family' });
    expect(viaApi.status).toBe(403);

    const direct = await api.db
      .asParent(
        guardian.userId,
        (tx) => tx`select id from public.request_deletion(${family.familyId}::uuid, null)`,
        { sessionId: guardian.sessionId },
      )
      .then(
        () => 'accepted',
        () => 'refused',
      );

    const [row] = await api.db.sql<{ deleted_at: Date | null }[]>`
      select deleted_at from public.families where id = ${family.familyId}`;
    expect({ direct, familyTombstoned: row!.deleted_at !== null }).toEqual({
      direct: 'refused',
      familyTombstoned: false,
    });
  });

  it('[RV-privacy-2] a whole-family export requested while a child deletion is pending does not carry that child’s data', async () => {
    // Spec P4: "Deletion requests should stop processing immediately"; the vertical itself refuses a
    // per-child export while that child's deletion is pending (CHILD_DELETION_PENDING). A whole-family
    // export has no childId, so it passes that check and the builder copies every child_profiles row
    // of the family — including the child being deleted.
    const { family, token } = await unlockedFamily(2);
    const riley = family.children[0]!.id;
    const del = await requestDeletion(token, { scope: 'child', childId: riley });
    expect(del.status).toBe(202);

    const res = await requestExport(token, { kind: 'family_data' });
    if (res.status === 202) {
      const { export: created } = dataExportResponseSchema.parse(await res.json());
      await runExportBuild(created.id);
      const row = await exportRow(created.id);
      const content = row?.storage_path ? (uploaded.get(row.storage_path) ?? '') : '';
      expect(row?.status).toBe('ready');
      // The export still builds for the rest of the family, but never with the deleted child in it.
      expect(content.includes(riley)).toBe(false);
    } else {
      // A fix may instead refuse the request while a deletion is pending.
      expect(res.status).toBe(422);
    }
  });

  it('[RV-privacy-3] a whole-family export built before a child’s deletion is no longer downloadable once that child is purged', async () => {
    // Spec P4: "Purge active uploads, derivatives ... on deletion"; AC_ACCESS_10: "parent deletion
    // removes active data". app.purge_family_data deletes only data_exports rows whose child_id is
    // the deleted child, so a family-wide export (child_id null) that contains the child survives,
    // stays 'ready' and keeps its file in private storage.
    const { family, token } = await unlockedFamily(2);
    const riley = family.children[0]!.id;
    const res = await requestExport(token, { kind: 'family_data' });
    expect(res.status).toBe(202);
    const { export: created } = dataExportResponseSchema.parse(await res.json());
    await runExportBuild(created.id);
    const built = await exportRow(created.id);
    expect(built?.status).toBe('ready');
    const path = built!.storage_path!;
    expect(uploaded.get(path)).toContain(riley); // the file really holds Riley's records

    const del = await requestDeletion(token, { scope: 'child', childId: riley });
    expect(del.status).toBe(202);
    const { deletion } = deletionRequestResponseSchema.parse(await del.json());
    await runPurge(deletion.id);

    const download = await api.request(`/v1/exports/${created.id}/download`, { token });
    expect({
      downloadStatus: download.status === 200 ? 200 : 'refused',
      fileStillStored: api.providers.storage.objects.has(path),
    }).toEqual({ downloadStatus: 'refused', fileStillStored: false });
  });

  it('[RV-privacy-4] a family deletion purge removes the family’s export files from private storage', async () => {
    // Spec P4: "Purge active uploads, derivatives, provider objects if any, queue payloads and caches
    // on deletion"; E4: "purge owned derivatives". The purge job removes only source_pages objects;
    // exports/{family}/{id}.json (every child's records) stays in storage after its row is deleted.
    const { family, token } = await unlockedFamily(1);
    const res = await requestExport(token, { kind: 'family_data' });
    expect(res.status).toBe(202);
    const { export: created } = dataExportResponseSchema.parse(await res.json());
    await runExportBuild(created.id);
    const path = (await exportRow(created.id))!.storage_path!;
    expect(api.providers.storage.objects.has(path)).toBe(true);

    const del = await requestDeletion(token, { scope: 'family' });
    expect(del.status).toBe(202);
    const { deletion } = deletionRequestResponseSchema.parse(await del.json());
    await runPurge(deletion.id);

    expect(await exportRow(created.id)).toBeUndefined(); // the row is purged…
    expect(api.providers.storage.objects.has(path)).toBe(false); // …and so must the file be
    expect([...api.providers.storage.objects].filter((p) => p.includes(family.familyId))).toEqual(
      [],
    );
  });

  it('[RV-privacy-5] after the owner deletes the family, a guardian can still see that deletion status', async () => {
    // Spec P14: "deleted-account states"; AC_UX_02 meaningful states. GET /v1/deletion returns only
    // requests the caller made plus a *live* family's requests, so the other guardian gets an empty
    // list; the privacy page then tells them "There is no family on this account yet. Set up your
    // family", and creating one fails (409) until the purge runs.
    const { family, token } = await unlockedFamily(1);
    const guardian = await unlockedGuardian(family);
    const del = await requestDeletion(token, { scope: 'family' });
    expect(del.status).toBe(202);
    const { deletion } = deletionRequestResponseSchema.parse(await del.json());

    const create = await api.request('/v1/families', {
      method: 'POST',
      token: guardian.token,
      body: { displayName: 'Another family', timezone: 'America/Chicago' },
    });
    expect(create.status).toBe(409); // the "set up your family" path is a dead end meanwhile

    const seen = deletionRequestsResponseSchema.parse(
      await (await api.request('/v1/deletion', { token: guardian.token })).json(),
    );
    expect(seen.requests.map((r) => [r.id, r.scope])).toEqual([[deletion.id, 'family']]);
  });

  it('[RV-privacy-8] GET /v1/exports reports an export past its expiry as expired, not ready', async () => {
    // Spec P14/AC_UX_02: honest states; the export contract and both parent screens define an
    // 'expired' status ("Expired — request a new copy"), and the download route refuses an expired
    // file. Nothing ever sets data_exports.status = 'expired' and GET /v1/exports returns the stored
    // status, so a lapsed export keeps showing as ready while its download is refused.
    const { token } = await unlockedFamily(1);
    const res = await requestExport(token, { kind: 'progress_csv' });
    expect(res.status).toBe(202);
    const { export: created } = dataExportResponseSchema.parse(await res.json());
    await runExportBuild(created.id);
    expect((await exportRow(created.id))?.status).toBe('ready');

    const start = api.now.value;
    api.now.value = new Date(start.getTime() + 8 * 86_400_000); // past the 7-day export TTL
    try {
      const download = await api.request(`/v1/exports/${created.id}/download`, { token });
      expect(download.status).toBe(409); // the file is refused as expired…
      const listed = await json<{ exports: { id: string; status: string }[] }>(
        await api.request('/v1/exports', { token }),
      );
      // …so the list must not keep calling it ready.
      expect(listed.exports.find((e) => e.id === created.id)?.status).toBe('expired');
    } finally {
      api.now.value = start;
    }
  });

  it('[RV-privacy-6] the runbook documents the safety-report moderation and escalation workflow', () => {
    // Spec P4: "adult report management and an escalation protocol for serious safety concerns ...
    // Safety templates and human review procedures must exist before launch"; AC_SECURITY_01: "follows
    // the documented moderation workflow". routes/privacy.ts says serious concerns "follow the
    // escalation path documented in the runbook", but the runbook only covers answer_revealed leaks.
    const runbook = readFileSync(
      fileURLToPath(new URL('../../../docs/Deployment_Runbook.md', import.meta.url)),
      'utf8',
    );
    expect(runbook).toMatch(/escalat/i);
    expect(runbook).toMatch(/upsetting|unsafe_content/);
  });
});

describe('privacy review probes (held up)', () => {
  it('probe: concurrent family deletions create one request and one purge job', async () => {
    const { family, token } = await unlockedFamily(1);
    const results = await Promise.all([
      requestDeletion(token, { scope: 'family' }),
      requestDeletion(token, { scope: 'family' }),
    ]);
    expect(results.filter((r) => r.status === 202)).toHaveLength(1);
    const requests = await api.db.sql<{ id: string }[]>`
      select id from public.deletion_requests where family_id = ${family.familyId}`;
    expect(requests).toHaveLength(1);
    const jobs = await api.db.sql<{ id: string }[]>`
      select id from public.jobs where family_id = ${family.familyId} and kind = 'deletion_purge'`;
    expect(jobs).toHaveLength(1);
  });

  it('probe: a child token cannot request deletion, and another family cannot read a family’s deletion', async () => {
    const { family, token } = await unlockedFamily(1);
    const outsider = await unlockedFamily(1);
    const kid = await api.request(`/v1/children/${family.children[0]!.id}/pairing-code`, {
      method: 'POST',
      token,
    });
    const paired = await api.request('/v1/child/pair', {
      method: 'POST',
      headers: { 'cf-connecting-ip': '198.51.100.77' },
      body: {
        code: (await json<{ code: string }>(kid)).code,
        deviceLabel: 'Review tablet',
        platform: 'ios',
      },
    });
    const childToken = (await json<{ accessToken: string }>(paired)).accessToken;
    expect((await requestDeletion(childToken, { scope: 'family' })).status).toBe(401);

    const del = await requestDeletion(token, { scope: 'child', childId: family.children[0]!.id });
    expect(del.status).toBe(202);
    const { deletion } = deletionRequestResponseSchema.parse(await del.json());
    const theirs = deletionRequestsResponseSchema.parse(
      await (await api.request('/v1/deletion', { token: outsider.token })).json(),
    );
    expect(theirs.requests.map((r) => r.id)).not.toContain(deletion.id);
  });

  it('probe: the admin queue needs aal2 even for PATCH, and a note can never be read back', async () => {
    const { token } = await unlockedFamily(1);
    const created = await api.request('/v1/safety-reports', {
      method: 'POST',
      token,
      body: { category: 'unsafe_content', note: 'Synthetic note text for Riley' },
    });
    expect(created.status).toBe(201);
    const { report } = await json<{ report: { id: string } }>(created);
    const adminId = await api.db.createUser();
    await api.db
      .sql`insert into public.admin_users (user_id, role) values (${adminId}, 'owner_admin')`;
    const aal1 = await parentToken(adminId, { aal: 'aal1' });
    const denied = await api.request(`/v1/admin/safety-reports/${report.id}`, {
      method: 'PATCH',
      token: aal1,
      body: { status: 'triaged' },
    });
    expect(denied.status).toBe(403);
    const aal2 = await parentToken(adminId, { aal: 'aal2' });
    const raw = await (await api.request('/v1/admin/safety-reports', { token: aal2 })).text();
    expect(raw).toContain(report.id);
    expect(raw).not.toContain('Synthetic note text');
    expect(raw).not.toContain('Riley');
  });
});
