import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PARENT_SAFETY_FLAG_ACTIONS,
  PARENT_SAFETY_FLAG_COPY,
  type AccountCloseOutcome,
  type DeletionRequest,
  type PrivacyFamilyView,
  type SafetyReport,
} from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import {
  accountClosedDeviceMessage,
  closeAccountAction,
  confirmationPhrase,
  deletableChildren,
  deletionStatusText,
  exportDownloadAction,
  exportLine,
  familyDeletion,
  loadPrivacyOverview,
  MOBILE_EXPORT_OPTIONS,
  PRIVACY_RETENTION_LINES,
  reportOutcomeAction,
  requestDeletionAction,
  requestExportAction,
  runAccountClosure,
  SAFETY_REPORTS_INTRO,
  safetyReportView,
  unlockAction,
  type AccountClosureStep,
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

const REPORT = 'c07c8d9e-0f1a-4b2c-9d4e-5f6a7b8c9d0e';

/** A family report with the contract's full shape; nothing acted on or sent unless overridden. */
function report(overrides: Partial<SafetyReport> = {}): SafetyReport {
  return {
    id: REPORT,
    reporterKind: 'child',
    category: 'answer_revealed',
    childId: RILEY,
    questionId: null,
    note: null,
    status: 'open',
    createdAt: '2026-09-23T15:00:00.000Z',
    triagedAt: null,
    resolvedAt: null,
    clearedAsFalseMatch: false,
    parentActionAt: null,
    parentOutcome: null,
    emailedAt: null,
    emailStatus: 'not_sent',
    ...overrides,
  };
}

/** A safety-screen flag about Riley, escalated and unresolved unless overridden. */
function flag(overrides: Partial<SafetyReport> = {}): SafetyReport {
  return report({
    reporterKind: 'system',
    category: 'severe_risk',
    questionId: 'e29e1f2a-3b4c-4d5e-8f6a-7b8c9d0e1f2a',
    status: 'escalated',
    ...overrides,
  });
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
    expect(text).toMatch(
      /does not cancel an app store, google play or amazon appstore subscription/i,
    );
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
    const good = fakeApi({
      send: () => ({ unlockedUntil: '2026-09-24T15:05:00.000Z', unlockSeconds: 300 }),
    });
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
    expect(overview.reports).toEqual([]);
    expect(familyDeletion(overview.deletions)).toEqual(familyRequest);
    expect(deletionStatusText(familyRequest)).toMatch(/processing has stopped/i);
  });

  it('[APL-20] a ready export opens through a one-minute signed link and never says the service is off', async () => {
    const line = exportLine({
      id: EXPORT,
      kind: 'progress_csv',
      childId: null,
      status: 'ready',
      createdAt: '2026-09-24T15:00:00.000Z',
      expiresAt: '2026-10-01T15:00:00.000Z',
    });
    expect(line).toBe('Progress data (CSV) · Ready to download');
    expect(line).not.toMatch(/isn.t available|switched on/i);

    const opened: string[] = [];
    const open = (url: string) => {
      opened.push(url);
      return Promise.resolve();
    };
    const ok = fakeApi({
      get: (path) =>
        path === `/v1/exports/${EXPORT}/download`
          ? {
              url: 'https://storage.example.test/signed/x.csv?t=1',
              expiresAt: '2026-09-24T15:01:00.000Z',
            }
          : new Error(`unexpected ${path}`),
    });
    expect(await exportDownloadAction(ok.api, EXPORT, open)).toMatchObject({ status: 'done' });
    expect(opened).toEqual(['https://storage.example.test/signed/x.csv?t=1']);

    const stepUp = fakeApi({
      get: () => new ApiRequestError('STEP_UP_REQUIRED', 'Enter your parent PIN', 403),
    });
    expect(await exportDownloadAction(stepUp.api, EXPORT, open)).toEqual({ status: 'step_up' });
    expect(opened).toHaveLength(1);
  });

  /**
   * HUNT5-N6 / L-037. `ACCOUNT_CLOSE_COPY.closed` and `.pending` both end "and this device is signed
   * out", which is the APP's half of closing an account, not the server's: the app clears the parent
   * session, the biometric PIN and the adult secrets afterwards. The screen used to print that
   * sentence before the sign-out had even run, and swallowed its failure, so a parent could read that
   * the device was signed out while it was not — and then put it down. The portal already told the two
   * cases apart; this is the same distinction on the app, in the app's own words.
   *
   * HUNT6-J-1: the distinction was asserted and never performed. Every step that could leave the
   * device signed in swallowed its failure — `auth.signOut().catch(() => undefined)` in
   * src/lib/mode.ts, `parentAuth.signOut()` dropping supabase's `{ error }`, the two best-effort
   * clears in src/family/runtime.ts — so the flag the screen read meant "no keychain write threw",
   * not "this device is signed out". The message is chosen from the REPORTED outcome now, and the
   * cases below run the helper rather than grepping the screen for a ternary (L-054).
   */
  const SIGNED_OUT = { sessionEndConfirmed: true, secretsCleared: true } as const;
  /** The copy ASSERTING that the device is signed out, as opposed to hedging about it. */
  const ASSERTS_SIGNED_OUT = /(?:^|[.!]\s+|\band\s+)this device is signed out/i;
  /** Every settled closure, and what the SERVER's half of it says when the device's half failed. */
  const OUTCOMES = ['closed', 'after_family_purge', 'retrying'] as const;
  const SERVER_HALF: Record<AccountCloseOutcome, RegExp> = {
    closed: /account is closed/i,
    after_family_purge: /closes automatically once your family account/i,
    retrying: /could not finish closing your sign-in/i,
  };

  it('[HUNT5-N6] says the device is signed out only when the sign-out reported that it was', () => {
    for (const status of OUTCOMES) {
      expect(ASSERTS_SIGNED_OUT.test(accountClosedDeviceMessage(status, SIGNED_OUT))).toBe(true);

      // [repro] HUNT6-J-1: the sign-out did not confirm the session ended. The account is closed
      // either way, so that half stays; the claim about the device in front of the parent must go.
      const failed = accountClosedDeviceMessage(status, {
        sessionEndConfirmed: false,
        secretsCleared: true,
      });
      expect(failed).toMatch(SERVER_HALF[status]);
      expect(ASSERTS_SIGNED_OUT.test(failed)).toBe(false);
      // And it claims neither state: supabase-js removes the local session even when the logout call
      // failed, so "we could not sign this device out" would be an overstatement in the other
      // direction. What the app knows is that it could not confirm — and the action it names is the
      // right one whichever way it went.
      expect(failed).toMatch(/could not confirm this device is signed out/i);
      expect(failed).not.toMatch(/could not sign this device out/i);
      expect(failed).toMatch(/sign out from the parent menu/i);

      // The session end was confirmed but a device secret stayed: "signed out" is true and is said,
      // and what did not happen is said too.
      const partial = accountClosedDeviceMessage(status, {
        sessionEndConfirmed: true,
        secretsCleared: false,
      });
      expect(ASSERTS_SIGNED_OUT.test(partial)).toBe(true);
      expect(partial).toMatch(/could not remove everything/i);
      expect(partial).not.toMatch(/could not confirm/i);
    }
  });

  it('[repro] does not send a parent whose sign-in is gone to change its password (HUNT6-J-3)', () => {
    // A completed closure soft-deletes the auth user: the email is replaced by a hash and every
    // session ends (apps/api/src/providers/auth-admin.ts), and ACCOUNT_CLOSE_COPY.intro says the
    // email and password stop working. So there is no password to change and no sign-in to change it
    // from — the advice was the one thing that cannot work, offered to the parent most likely to act
    // on it. It stays on `pending`, where ownerRule says the parent can still sign in.
    for (const device of [
      { sessionEndConfirmed: false, secretsCleared: true },
      { sessionEndConfirmed: true, secretsCleared: false },
    ] as const) {
      expect(accountClosedDeviceMessage('closed', device)).not.toMatch(/change your password/i);
      // Both pending causes leave the sign-in in place — the owner's until the purge finishes, the
      // refused one until the queued job closes it — so the remedy is real on both.
      expect(accountClosedDeviceMessage('after_family_purge', device)).toMatch(
        /change your password/i,
      );
      expect(accountClosedDeviceMessage('retrying', device)).toMatch(/change your password/i);
    }
  });

  /**
   * HUNT7-E-1. PREMISE: a `pending` answer has two causes, and only one of them is a family purge —
   * POST /v1/account/close answers `pending` for a guardian (or an adult with no family) whenever
   * `closeNow` could not close the sign-in, a path apps/api/tests/account-close.test.ts covers under
   * 'guardian path when the auth service refuses' and the route's own header states. Their family is
   * not being deleted at all: `removeGuardian` revokes their membership and the family stays live with
   * its owner. The app printed the owner's sentence for both, so that parent read that their sign-in
   * closes "once your family account's deletion has finished" — an event that will never happen, which
   * reads as "nothing will close it", while the real mechanism (the queued `account_close` job
   * retrying) was never mentioned. The reason now comes from the route, so each cause gets its own
   * sentence; the app must print the one it was told.
   */
  it('[repro] a retried closure does not blame a family deletion for it (HUNT7-E-1)', () => {
    const FAMILY_PURGE = /family account’s deletion has finished/i;
    // The owner's cause is the purge, and keeps saying so.
    expect(accountClosedDeviceMessage('after_family_purge', SIGNED_OUT)).toMatch(FAMILY_PURGE);
    for (const device of [
      SIGNED_OUT,
      { sessionEndConfirmed: false, secretsCleared: true },
      { sessionEndConfirmed: true, secretsCleared: false },
    ] as const) {
      const retrying = accountClosedDeviceMessage('retrying', device);
      expect(retrying).not.toMatch(FAMILY_PURGE);
      expect(retrying).not.toMatch(/family/i);
      // And it says what IS happening: the close is being retried until it goes through.
      expect(retrying).toMatch(/could not finish closing your sign-in/i);
      expect(retrying).toMatch(/keeps trying/i);
    }
  });

  /**
   * HUNT6-J-2. The screen cleared its busy flag as soon as the API answered and set its outcome only
   * after the device sign-out, which is up to three network calls at a 20-second default timeout. In
   * between it looked idle with every control live, including a second "Delete my account" that the
   * still-live token and still-recent unlock accept: a second close job and a second audit row. The
   * ORDER is the fix, so the order is what is tested — the previous check grepped the screen for the
   * await and the ternary, which both orderings satisfy.
   */
  describe('the closure takes the screen out of "ready" before the device sign-out (HUNT6-J-2)', () => {
    const closingApi = () => fakeApi({ send: () => ({ status: 'closed', signOut: true }) });

    it('[repro] the controls are gone while the sign-out runs, not after it', async () => {
      const steps: string[] = [];
      let release = (_: { sessionEndConfirmed: boolean; secretsCleared: boolean }) =>
        undefined as void;
      const pending = new Promise<{ sessionEndConfirmed: boolean; secretsCleared: boolean }>(
        (resolve) => {
          release = resolve;
        },
      );
      const done = runAccountClosure(
        closingApi().api,
        true,
        () => pending,
        (step) => steps.push(step.kind),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      // The sign-out has not answered, and the screen has already left 'ready'.
      expect(steps).toEqual(['closing']);
      release(SIGNED_OUT);
      await done;
      expect(steps).toEqual(['closing', 'closed']);
    });

    it('[repro] a device sign-out that throws still reaches the outcome, and claims nothing', async () => {
      // The sign-out reads and writes the keychain outside a catch, so it can reject; leaving that
      // unhandled would strand the parent on "Signing this device out…" with the screen busy.
      const steps: AccountClosureStep[] = [];
      await runAccountClosure(
        closingApi().api,
        true,
        () => Promise.reject(new Error('keychain unavailable')),
        (step) => steps.push(step),
      );
      expect(steps.map((step) => step.kind)).toEqual(['closing', 'closed']);
      const closed = steps[1];
      expect(closed?.kind === 'closed' && closed.message).toMatch(/could not confirm/i);
    });

    it('a refused closure leaves the screen ready with feedback, and never says it closed', async () => {
      const steps: AccountClosureStep[] = [];
      const refused = fakeApi({
        send: () => new ApiRequestError('STEP_UP_REQUIRED', 'Enter your parent PIN', 403),
      });
      await runAccountClosure(
        refused.api,
        true,
        () => Promise.resolve(SIGNED_OUT),
        (step) => steps.push(step),
      );
      expect(steps).toEqual([{ kind: 'refused', result: { status: 'step_up' } }]);
    });

    it('an unconfirmed closure never reaches the API or the sign-out', async () => {
      const steps: AccountClosureStep[] = [];
      const api = closingApi();
      let signOuts = 0;
      await runAccountClosure(
        api.api,
        false,
        () => {
          signOuts += 1;
          return Promise.resolve(SIGNED_OUT);
        },
        (step) => steps.push(step),
      );
      expect(api.calls).toHaveLength(0);
      expect(signOuts).toBe(0);
      expect(steps.map((step) => step.kind)).toEqual(['refused']);
    });
  });

  it('[HUNT6-J-5/J-6] the closure rules document the action, and the closed state says what it means', () => {
    // J-5: the new copy helper was inserted between `closeAccountAction` and its JSDoc, so the block
    // describing a POST, a confirmation tick and the FAMILY_DELETION_REQUIRED rule arrived above a
    // function that does none of those — which is what an editor hover shows.
    const source = readFileSync(join(import.meta.dirname, 'parent-privacy.ts'), 'utf8');
    const docFor = (declaration: string) =>
      new RegExp(`/\\*\\*((?:(?!\\*/)[\\s\\S])*)\\*/\\s*${declaration}`).exec(source)?.[1] ?? '';
    expect(docFor('export async function closeAccountAction')).toMatch(/POST \/v1\/account\/close/);
    expect(docFor('export function accountClosedDeviceMessage')).not.toMatch(
      /POST \/v1\/account\/close/,
    );

    // J-6: the screen's own state was documented as "the device is signed out", which is precisely
    // what the state can no longer be taken to mean.
    const privacy = readFileSync(
      join(import.meta.dirname, '..', '..', 'app', '(parent)', 'privacy.tsx'),
      'utf8',
    );
    const closedDoc =
      /\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*\| \{ status: 'account_closed'/.exec(privacy)?.[1] ?? '';
    expect(closedDoc).not.toBe('');
    expect(closedDoc).not.toMatch(/the device is signed out;/);
    expect(closedDoc).toMatch(/whether/i);
  });

  it('[APL-07 / PLAY-10] deletes the parent’s own sign-in only once confirmed, and maps the owner rule and step-up', async () => {
    const closed = fakeApi({ send: () => ({ status: 'closed', signOut: true }) });
    expect(await closeAccountAction(closed.api, false)).toMatchObject({ status: 'error' });
    expect(closed.calls).toHaveLength(0);
    // HUNT7-K-4: the success statuses carry no message of their own. Round 6 moved the decision of
    // what the parent reads into `runAccountClosure`, which passes only `result.status` to
    // `accountClosedDeviceMessage` — while this function went on building the unconditional 'Your
    // PencilLift account is closed and this device is signed out.' that nothing renders, and this
    // assertion pinned that sentence as required output. It would have stayed green if
    // `accountClosedDeviceMessage` were reverted to printing it unconditionally, which is the one thing
    // it exists to prevent; the sentence is asserted where it is now decided, above.
    expect(await closeAccountAction(closed.api, true)).toEqual({ status: 'closed' });
    expect(closed.calls).toEqual([
      { method: 'POST', path: '/v1/account/close', body: { confirm: true } },
    ]);

    // HUNT7-E-1: `pending` alone does not say what the parent should read, so the reason the route
    // gave travels with it instead of being guessed at the screen.
    const pending = fakeApi({
      send: () => ({ status: 'pending', reason: 'retrying', signOut: true }),
    });
    expect(await closeAccountAction(pending.api, true)).toEqual({
      status: 'pending',
      reason: 'retrying',
    });
    const afterPurge = fakeApi({
      send: () => ({ status: 'pending', reason: 'after_family_purge', signOut: true }),
    });
    expect(await closeAccountAction(afterPurge.api, true)).toEqual({
      status: 'pending',
      reason: 'after_family_purge',
    });

    // And the copy is not reachable by field access from here either: an error keeps its message,
    // because the 'refused' step is what shows it.
    const source = readFileSync(join(import.meta.dirname, 'parent-privacy.ts'), 'utf8');
    const body = /export async function closeAccountAction\(([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
    expect(body).not.toBe('');
    expect(body).not.toMatch(/ACCOUNT_CLOSE_COPY\.(closed|pending)\b/);
    expect(body).toMatch(/ACCOUNT_CLOSE_COPY\.familyDeletionRequired/);

    const owner = fakeApi({
      send: () =>
        new ApiRequestError(
          'CONFLICT',
          'Delete your whole family account first',
          409,
          'FAMILY_DELETION_REQUIRED',
        ),
    });
    const refused = await closeAccountAction(owner.api, true);
    expect(refused.status).toBe('error');
    expect(refused.status === 'error' && refused.message).toMatch(
      /delete your whole family account first, then delete your account/i,
    );

    const stepUp = fakeApi({
      send: () => new ApiRequestError('STEP_UP_REQUIRED', 'Enter your parent PIN', 403),
    });
    expect(await closeAccountAction(stepUp.api, true)).toEqual({ status: 'step_up' });

    const offline = fakeApi({ send: () => new ApiRequestError('NETWORK', 'offline', 0) });
    const down = await closeAccountAction(offline.api, true);
    expect(down.status === 'error' && down.message).toMatch(/offline/i);
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

  it('loads the family safety reports with the rest of the overview', async () => {
    const { api, calls } = fakeApi({
      get: (path) => {
        if (path === '/v1/family') return FAMILY;
        if (path === '/v1/deletion') return { requests: [] };
        if (path === '/v1/exports') return { exports: [] };
        if (path === '/v1/safety-reports') return { reports: [flag()] };
        return new Error(`unexpected ${path}`);
      },
    });
    const overview = await loadPrivacyOverview(api);
    expect(overview.reports.map((r) => r.id)).toEqual([REPORT]);
    expect(calls.map((c) => c.path)).toContain('/v1/safety-reports');
  });
});

describe('family safety reports on the phone (owner decision, 2026-09-25)', () => {
  // The parent is the only person PencilLift sends a safety message to and addresses the concern:
  // every flag is listed at once, says truthfully whether the guardian email was sent, and offers
  // the same two actions as the web portal, with the same wording (contracts).
  it('explains flags, the guardian email and the actions without promising a staffed review', () => {
    expect(SAFETY_REPORTS_INTRO).toMatch(/flags one of your child’s answers/i);
    expect(SAFETY_REPORTS_INTRO).toMatch(/emails the guardians on this account/i);
    expect(SAFETY_REPORTS_INTRO).toMatch(/says whether that email was sent/i);
    expect(SAFETY_REPORTS_INTRO).not.toMatch(
      /kept off this list|reviewer releases|no automatic alert/i,
    );
    expect(SAFETY_REPORTS_INTRO).not.toMatch(
      /looks at every flag|reviews every flag|every flag is reviewed/i,
    );
  });

  it('shows a flag honestly: what the child sees, the recorded email state, the hotlines, both actions', () => {
    const view = safetyReportView(FAMILY, flag());
    expect(view.title).toBe(PARENT_SAFETY_FLAG_COPY.category);
    expect(view.meta).toMatch(/flagged by pencillift/i);
    expect(view.meta).toMatch(/about riley/i);
    expect(view.meta).toMatch(/escalated for urgent review/i);
    expect(view.meta).toMatch(/sep 23, 2026/i);
    expect(view.lines).toEqual([
      PARENT_SAFETY_FLAG_COPY.summary,
      PARENT_SAFETY_FLAG_COPY.emailNotSent,
      PARENT_SAFETY_FLAG_COPY.resources,
    ]);
    expect(view.actions).toEqual([
      { outcome: 'addressed', ...PARENT_SAFETY_FLAG_ACTIONS.addressed },
      { outcome: 'false_match', ...PARENT_SAFETY_FLAG_ACTIONS.falseMatch },
    ]);
    // Same wording as the portal; the false-alarm action says what it does to the results.
    expect(view.actions[1]!.effect).toMatch(/removes the message from your child’s results/i);
    const all = [view.title, view.meta, ...view.lines].join(' ');
    // Never claims a delivery that did not happen; never names the kind of concern.
    expect(all.replace(PARENT_SAFETY_FLAG_COPY.emailNotSent, '')).not.toMatch(
      /alerted|notified|we (?:emailed|texted|sent)|pencillift emailed/i,
    );
    expect(all.replace(PARENT_SAFETY_FLAG_COPY.resources, '')).not.toMatch(
      /self-harm|suicid|abuse|sexual|violen/i,
    );
    expect(all).not.toMatch(/your child saw/i);
  });

  it('says an email was sent only from the recorded delivery, and says when it failed', () => {
    const sent = safetyReportView(
      FAMILY,
      flag({ emailStatus: 'sent', emailedAt: '2026-09-23T15:00:05.000Z' }),
    );
    expect(sent.lines).toContain(PARENT_SAFETY_FLAG_COPY.emailSent);
    const failed = safetyReportView(FAMILY, flag({ emailStatus: 'failed' }));
    expect(failed.lines).toContain(PARENT_SAFETY_FLAG_COPY.emailFailed);
    expect(failed.lines).not.toContain(PARENT_SAFETY_FLAG_COPY.emailSent);
    expect(PARENT_SAFETY_FLAG_COPY.emailFailed).toMatch(/could not be sent/i);
  });

  it('a resolved flag shows its outcome and offers no action', () => {
    const addressed = safetyReportView(
      FAMILY,
      flag({
        status: 'resolved',
        resolvedAt: '2026-09-24T15:00:00.000Z',
        parentActionAt: '2026-09-24T15:00:00.000Z',
        parentOutcome: 'addressed',
        emailStatus: 'sent',
        emailedAt: '2026-09-23T15:00:05.000Z',
      }),
    );
    expect(addressed.meta).toMatch(/resolved/i);
    expect(addressed.lines[0]).toBe(PARENT_SAFETY_FLAG_COPY.addressed);
    expect(addressed.lines).not.toContain(PARENT_SAFETY_FLAG_COPY.summary);
    expect(addressed.actions).toEqual([]);
    // Cleared as a false match, by a guardian or a reviewer: the summary would no longer be true.
    for (const parentOutcome of ['false_match', null] as const) {
      const cleared = safetyReportView(
        FAMILY,
        flag({
          status: 'resolved',
          resolvedAt: '2026-09-24T15:00:00.000Z',
          clearedAsFalseMatch: true,
          parentActionAt: parentOutcome ? '2026-09-24T15:00:00.000Z' : null,
          parentOutcome,
        }),
      );
      expect(cleared.lines[0]).toBe(PARENT_SAFETY_FLAG_COPY.cleared);
      expect(cleared.actions).toEqual([]);
    }
  });

  it('a child’s report offers "looked into" only; a parent’s report offers nothing', () => {
    const child = safetyReportView(FAMILY, report());
    expect(child.title).toBe('Showed an answer');
    expect(child.meta).toMatch(/reported by riley/i);
    expect(child.meta).toMatch(/waiting for review/i);
    expect(child.lines).toEqual([PARENT_SAFETY_FLAG_COPY.emailNotSent]);
    expect(child.actions.map((a) => a.outcome)).toEqual(['addressed']);
    const looked = safetyReportView(
      FAMILY,
      report({
        status: 'resolved',
        resolvedAt: '2026-09-24T15:00:00.000Z',
        parentActionAt: '2026-09-24T15:00:00.000Z',
        parentOutcome: 'addressed',
      }),
    );
    expect(looked.lines).toEqual([
      PARENT_SAFETY_FLAG_COPY.childReportAddressed,
      PARENT_SAFETY_FLAG_COPY.emailNotSent,
    ]);
    expect(looked.actions).toEqual([]);
    const parent = safetyReportView(
      FAMILY,
      report({
        reporterKind: 'parent',
        category: 'wrong_or_confusing',
        childId: SAM,
        note: 'The hint did not match the worksheet.',
      }),
    );
    expect(parent.meta).toMatch(/reported by a parent/i);
    expect(parent.note).toBe('The hint did not match the worksheet.');
    expect(parent.actions).toEqual([]);
    // A removed child profile is named as such, never by a stale id.
    expect(safetyReportView(null, report()).meta).toMatch(/a removed child profile/i);
  });

  it('sends the outcome and maps step-up, an already-resolved report and offline honestly', async () => {
    const resolved = flag({
      status: 'resolved',
      resolvedAt: '2026-09-24T15:00:00.000Z',
      parentActionAt: '2026-09-24T15:00:00.000Z',
      parentOutcome: 'false_match',
      clearedAsFalseMatch: true,
    });
    const { api, calls } = fakeApi({ send: () => ({ report: resolved }) });
    const done = await reportOutcomeAction(api, REPORT, 'false_match');
    expect(calls).toEqual([
      { method: 'PATCH', path: `/v1/safety-reports/${REPORT}`, body: { outcome: 'false_match' } },
    ]);
    expect(done).toEqual({ status: 'done', message: expect.stringMatching(/false alarm/i) });
    expect(
      await reportOutcomeAction(
        fakeApi({ send: () => ({ report: { ...resolved, parentOutcome: 'addressed' } }) }).api,
        REPORT,
        'addressed',
      ),
    ).toEqual({ status: 'done', message: expect.stringMatching(/looked into/i) });
    expect(
      await reportOutcomeAction(
        fakeApi({ send: () => new ApiRequestError('STEP_UP_REQUIRED', 'Enter your PIN', 403) }).api,
        REPORT,
        'addressed',
      ),
    ).toEqual({ status: 'step_up' });
    expect(
      await reportOutcomeAction(
        fakeApi({
          send: () => new ApiRequestError('CONFLICT', 'This report is already resolved', 409),
        }).api,
        REPORT,
        'addressed',
      ),
    ).toEqual({ status: 'error', message: 'This report is already resolved' });
    expect(
      await reportOutcomeAction(
        fakeApi({ send: () => new ApiRequestError('NETWORK', 'offline', 0) }).api,
        REPORT,
        'addressed',
      ),
    ).toEqual({ status: 'error', message: expect.stringMatching(/offline/i) });
  });
});
