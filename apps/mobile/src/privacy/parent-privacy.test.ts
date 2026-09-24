import { describe, expect, it } from 'vitest';
import type { DeletionRequest, PrivacyFamilyView } from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import {
  confirmationPhrase,
  deletableChildren,
  deletionStatusText,
  exportLine,
  familyDeletion,
  loadPrivacyOverview,
  MOBILE_EXPORT_OPTIONS,
  PRIVACY_RETENTION_LINES,
  requestDeletionAction,
  requestExportAction,
  unlockAction,
} from './parent-privacy.ts';

// Synthetic data only (Riley, Sam).
const FAMILY_ID = '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60';
const RILEY = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const SAM = '7a2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const REQUEST = 'be6b7c8d-9e0f-4a1b-8c3d-4e5f6a7b8c9d';
const EXPORT = 'ad5a6b7c-8d9e-4f0a-9b2c-3d4e5f6a7b8c';

const FAMILY: PrivacyFamilyView = {
  id: FAMILY_ID,
  children: [
    { id: RILEY, nickname: 'Riley', status: 'active' },
    { id: SAM, nickname: 'Sam', status: 'active' },
  ],
};

function request(overrides: Partial<DeletionRequest> = {}): DeletionRequest {
  return {
    id: REQUEST,
    scope: 'child',
    childId: SAM,
    status: 'requested',
    requestedAt: '2026-09-24T15:00:00.000Z',
    completeBy: '2026-10-24T15:00:00.000Z',
    completedAt: null,
    ...overrides,
  };
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function fakeApi(handlers: { get?: (path: string) => unknown; send?: (call: Call) => unknown }): {
  api: ApiClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  // Responses pass through the real contract schema, exactly as the production client does.
  const settle = (value: unknown, schema: { parse: (v: unknown) => unknown }): Promise<never> =>
    value instanceof Error ? Promise.reject(value) : Promise.resolve(schema.parse(value) as never);
  const api: ApiClient = {
    get: (path, schema) => {
      calls.push({ method: 'GET', path, body: undefined });
      return settle(handlers.get ? handlers.get(path) : new Error('unexpected GET'), schema);
    },
    send: (method, path, body, schema) => {
      const call = { method, path, body };
      calls.push(call);
      return settle(handlers.send ? handlers.send(call) : new Error('unexpected send'), schema);
    },
  };
  return { api, calls };
}

describe('parent privacy screen logic (spec P4, P10, P14)', () => {
  it('explains retention, deletion timing, backups, billing records and store subscriptions', () => {
    const text = PRIVACY_RETENTION_LINES.join(' ');
    expect(text).toMatch(/raw homework photos are deleted after 30 days by default/i);
    expect(text).toMatch(/within 30 days/i);
    expect(text).toMatch(/backups expire on a documented schedule/i);
    expect(text).toMatch(/billing records/i);
    expect(text).toMatch(/does not cancel an app store or google play subscription/i);
  });

  it('offers family exports only; the answer key is never offered on mobile', () => {
    expect(MOBILE_EXPORT_OPTIONS.map((o) => o.kind)).toEqual([
      'family_data',
      'progress_pdf',
      'progress_csv',
    ]);
  });

  it('requests an export and reports step-up and offline outcomes honestly', async () => {
    const created = {
      export: {
        id: EXPORT,
        kind: 'family_data',
        childId: null,
        status: 'queued',
        createdAt: '2026-09-24T15:00:00.000Z',
        expiresAt: null,
      },
    };
    const ok = fakeApi({ send: () => created });
    expect(await requestExportAction(ok.api, 'family_data')).toMatchObject({ status: 'done' });
    expect(ok.calls).toEqual([
      { method: 'POST', path: '/v1/exports', body: { kind: 'family_data' } },
    ]);

    const stepUp = fakeApi({
      send: () => new ApiRequestError('STEP_UP_REQUIRED', 'Enter your parent PIN', 403),
    });
    expect(await requestExportAction(stepUp.api, 'progress_pdf')).toEqual({ status: 'step_up' });

    const offline = fakeApi({ send: () => new ApiRequestError('NETWORK', 'offline', 0) });
    const result = await requestExportAction(offline.api, 'progress_csv');
    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toMatch(/offline/i);
  });

  it('never sends a deletion until the confirmation is typed exactly', async () => {
    const { api, calls } = fakeApi({ send: () => ({ deletion: request() }) });
    const sam = { scope: 'child' as const, childId: SAM, nickname: 'Sam' };
    expect(confirmationPhrase(sam)).toBe('Sam');
    expect(confirmationPhrase({ scope: 'family' })).toBe('DELETE');

    const wrong = await requestDeletionAction(api, sam, 'Riley');
    expect(wrong).toMatchObject({ status: 'error' });
    expect(await requestDeletionAction(api, { scope: 'family' }, 'delete')).toMatchObject({
      status: 'error',
    });
    expect(calls).toHaveLength(0);

    const done = await requestDeletionAction(api, sam, ' sam ');
    expect(done.status).toBe('done');
    expect(done.status === 'done' && done.message).toMatch(/Oct/);
    expect(calls).toEqual([
      { method: 'POST', path: '/v1/deletion', body: { scope: 'child', childId: SAM } },
    ]);

    await requestDeletionAction(api, { scope: 'family' }, 'DELETE');
    expect(calls[1]).toEqual({ method: 'POST', path: '/v1/deletion', body: { scope: 'family' } });
  });

  it('maps owner-only and step-up refusals', async () => {
    const owner = fakeApi({
      send: () =>
        new ApiRequestError(
          'FORBIDDEN',
          'Only the family owner can delete the whole family',
          403,
          'OWNER_ONLY_FAMILY_DELETION',
        ),
    });
    const refused = await requestDeletionAction(owner.api, { scope: 'family' }, 'DELETE');
    expect(refused.status === 'error' && refused.message).toMatch(/only the family owner/i);
    const stepUp = fakeApi({
      send: () => new ApiRequestError('STEP_UP_REQUIRED', 'Enter your parent PIN', 403),
    });
    expect(await requestDeletionAction(stepUp.api, { scope: 'family' }, 'DELETE')).toEqual({
      status: 'step_up',
    });
  });

  it('unlocks with a 6-digit PIN only and explains a wrong PIN', async () => {
    const good = fakeApi({ send: () => ({ unlockedUntil: '2026-09-24T15:05:00.000Z' }) });
    expect(await unlockAction(good.api, '12')).toMatchObject({ ok: false });
    expect(good.calls).toHaveLength(0);
    expect(await unlockAction(good.api, '482913')).toMatchObject({ ok: true });
    expect(good.calls[0]).toEqual({
      method: 'POST',
      path: '/v1/adult/unlock',
      body: { method: 'pin', pin: '482913' },
    });
    const bad = fakeApi({ send: () => new ApiRequestError('FORBIDDEN', 'Incorrect PIN', 403) });
    expect(await unlockAction(bad.api, '000001')).toEqual({
      ok: false,
      message: 'That PIN is not correct.',
    });
  });

  it('hides children whose deletion is already in progress', () => {
    expect(deletableChildren(FAMILY, [request()]).map((c) => c.nickname)).toEqual(['Riley']);
    expect(
      deletableChildren(FAMILY, [
        request({ status: 'completed', completedAt: '2026-09-25T00:00:00.000Z' }),
      ]).map((c) => c.nickname),
    ).toEqual(['Riley', 'Sam']);
  });

  it('loads a deleted family as a deleted-account state, not an error', async () => {
    const familyRequest = request({ scope: 'family', childId: null });
    const { api } = fakeApi({
      get: (path) =>
        path === '/v1/deletion'
          ? { requests: [familyRequest] }
          : new ApiRequestError('NOT_FOUND', 'Create your family first', 404),
    });
    const overview = await loadPrivacyOverview(api);
    expect(overview.family).toBeNull();
    expect(familyDeletion(overview.deletions)).toEqual(familyRequest);
    expect(deletionStatusText(familyRequest)).toMatch(/processing has stopped/i);
  });

  it('labels a lapsed or withdrawn export as expired, never as ready', () => {
    // The API reports an export past its expiry (or withdrawn by a deletion) as expired
    // (RV-privacy-8); the screen must say so instead of implying a copy is available.
    const line = exportLine({
      id: EXPORT,
      kind: 'family_data',
      childId: null,
      status: 'expired',
      createdAt: '2026-09-16T15:00:00.000Z',
      expiresAt: '2026-09-23T15:00:00.000Z',
    });
    expect(line).toBe('All family data · Expired — request a new copy');
  });

  it('propagates other load failures so the screen can offer a retry', async () => {
    const { api } = fakeApi({ get: () => new ApiRequestError('NETWORK', 'offline', 0) });
    await expect(loadPrivacyOverview(api)).rejects.toBeInstanceOf(ApiRequestError);
  });
});
