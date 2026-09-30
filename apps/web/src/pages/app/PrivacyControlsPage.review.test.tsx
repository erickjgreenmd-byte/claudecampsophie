// Independent adversarial review of the privacy vertical (REVIEW-PRIVACY): web parent privacy page.
// "[RV-privacy-<n>]" tests reproduce defects; "probe:" tests pin risky behaviour that held up.
// Synthetic data only (Riley, Sam).
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  deletionConfirmationCopy,
  deletionRequestedMessage,
  privacyRetentionLines,
  storeSubscriptionNotice,
} from '@pencillift/contracts';
import type {
  DataExports,
  DeletionRequests,
  PrivacyFamilyView,
  SafetyReports,
} from '@pencillift/contracts';
import type { ApiClient } from '@pencillift/contracts/client';
import { renderPage } from '../../test/render.tsx';
import PrivacyControlsPage from './PrivacyControlsPage.tsx';

const FAMILY_ID = '8b3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60';
const RILEY = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const SAM = '7a2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const DELETION_ID = 'be6b7c8d-9e0f-4a1b-8c3d-4e5f6a7b8c9d';

const FAMILY: PrivacyFamilyView = {
  id: FAMILY_ID,
  children: [
    { id: RILEY, nickname: 'Riley', status: 'archived' },
    { id: SAM, nickname: 'Sam', status: 'active' },
  ],
};

/** The completion instant every accepted deletion in this file answers with. */
const COMPLETE_BY = '2026-10-24T15:00:00.000Z';

/** The page's own date format, so the expected sentence is the contract's, whole. */
const portalDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

function fakeApi(
  deletions: DeletionRequests = { requests: [] },
  send?: (path: string) => unknown,
): Partial<ApiClient> {
  const settle = <S extends z.ZodType>(value: unknown, schema: S) =>
    Promise.resolve(schema.parse(value));
  return {
    get: <S extends z.ZodType>(path: string, schema: S) => {
      if (path === '/v1/family') return settle(FAMILY, schema);
      if (path === '/v1/deletion') return settle(deletions, schema);
      if (path === '/v1/exports') return settle({ exports: [] } satisfies DataExports, schema);
      if (path === '/v1/safety-reports') {
        return settle({ reports: [] } satisfies SafetyReports, schema);
      }
      return Promise.reject(new Error(`unexpected GET ${path}`));
    },
    send: <S extends z.ZodType>(_method: string, path: string, _body: unknown, schema: S) =>
      send ? settle(send(path), schema) : Promise.reject(new Error('unexpected send')),
  };
}

afterEach(cleanup);

describe('PrivacyControlsPage review', () => {
  it('[RV-privacy-7] the safety-report copy does not claim that “Tell a grown-up” saves a report', async () => {
    // Spec P4: "Never promise that the parent is alerted unless delivery is implemented and logged";
    // AC_SECURITY_01. On the child help screen "Tell a grown-up" is advice only (no network call);
    // only the separate "Tell PencilLift" choices save a report. The page tells parents that when
    // their child "uses “Tell a grown-up” in the app ... it is saved to PencilLift’s review queue and
    // its status is shown below", so a parent expects every help request to appear here.
    renderPage(<PrivacyControlsPage />, { api: fakeApi() });
    const section = await screen.findByRole('region', { name: /safety reports/i });
    const intro = section.querySelector('p')?.textContent ?? '';
    expect(intro).not.toMatch(/tell a grown-up[”"]?[^.]*saved/i);
  });

  it('probe: a child with a pending deletion is not offered for export, answer key or deletion', async () => {
    const deletions: DeletionRequests = {
      requests: [
        {
          id: DELETION_ID,
          scope: 'child',
          childId: RILEY,
          status: 'requested',
          requestedAt: '2026-09-24T15:00:00.000Z',
          completeBy: '2026-10-24T15:00:00.000Z',
          completedAt: null,
        },
      ],
    };
    renderPage(<PrivacyControlsPage />, { api: fakeApi(deletions) });
    const exportsSection = await screen.findByRole('region', { name: /export your data/i });
    const options = (label: RegExp, scope: HTMLElement) =>
      within(within(scope).getByLabelText(label))
        .getAllByRole('option')
        .map((o) => o.textContent);
    expect(options(/^child$/i, exportsSection)).toEqual(['Whole family', 'Sam']);
    expect(options(/child for the answer key/i, exportsSection)).toEqual(['Choose a child', 'Sam']);
    const deleteCard = screen.getByRole('group', { name: /delete a child’s data/i });
    expect(options(/child to delete/i, deleteCard)).toEqual(['Choose a child', 'Sam']);
    const list = screen.getByRole('list', { name: /deletion requests/i });
    expect(list.textContent).toMatch(/riley’s data/i);
  });
});

/**
 * BUG-411 / L-070 / L-071: the portal prints the contracts' deletion and retention sentences, for
 * the scope the parent actually chose. These are CALL-SITE tests: the sentences themselves are
 * asserted in packages/contracts/src/privacy.test.ts, and what is asserted here is the output this
 * screen hands the parent — a shared definition proves nothing if the screen picks the wrong
 * argument or keeps a sentence of its own beside it.
 */
describe('PrivacyControlsPage prints the shared deletion copy for the chosen scope', () => {
  const portalCopy = (target: Parameters<typeof deletionConfirmationCopy>[0]) =>
    deletionConfirmationCopy(target, null);

  it('[repro] a single child’s confirmation says what stays, and never the account-wide sentence', async () => {
    renderPage(<PrivacyControlsPage />, { api: fakeApi() });
    const card = await screen.findByRole('group', { name: /delete a child’s data/i });
    await userEvent.selectOptions(within(card).getByLabelText(/child to delete/i), SAM);
    const copy = portalCopy({ scope: 'child', childId: SAM, nickname: 'Sam' });
    const text = card.textContent ?? '';
    expect(text).toContain(copy.effect);
    expect(text).toContain(copy.storeNotice);
    expect(within(card).getByLabelText(copy.typePrompt)).toBeTruthy();
    // The family's sentences are the ones this card must never carry.
    const family = portalCopy({ scope: 'family' });
    expect(text).not.toContain(family.effect);
    expect(text).not.toContain(family.storeNotice);
    expect(text).not.toMatch(/Deleting your PencilLift (family )?account does not cancel/);
  });

  it('the whole-family confirmation says what it removes, with the family’s store sentence', async () => {
    renderPage(<PrivacyControlsPage />, { api: fakeApi() });
    const card = await screen.findByRole('group', { name: /delete your whole family account/i });
    const copy = portalCopy({ scope: 'family' });
    expect(card.textContent).toContain(copy.effect);
    expect(card.textContent).toContain(copy.storeNotice);
    expect(within(card).getByLabelText(copy.typePrompt)).toBeTruthy();
    expect(card.textContent).not.toContain(
      portalCopy({ scope: 'child', childId: SAM, nickname: 'Sam' }).effect,
    );
  });

  it('prints the shared retention lines, all six, and writes none of its own', async () => {
    renderPage(<PrivacyControlsPage />, { api: fakeApi() });
    const retention = await screen.findByRole('region', {
      name: /how long we keep information/i,
    });
    const items = within(retention)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    // The portal is sold through no store, so it can name none as the reader's own.
    expect(items).toEqual([...privacyRetentionLines(null)]);
    expect(retention.textContent).toContain(storeSubscriptionNotice('any', null));
  });
});

/**
 * The answer a parent reads AFTER the server accepts the request, on the portal. BUG-411's
 * highest-severity half was that the app's answer did not branch on scope; mutating the shared
 * `deletionRequestedMessage` to ignore the target reddened the app's suite and nothing here, so the
 * portal's own call site was unguarded. These two tests close that: each asserts the whole sentence
 * the screen shows, built from the contract for the scope the parent chose.
 */
describe('PrivacyControlsPage answers a deletion with the chosen scope’s sentence', () => {
  const accepted = (scope: 'child' | 'family') => ({
    deletion: {
      id: DELETION_ID,
      scope,
      childId: scope === 'child' ? SAM : null,
      status: 'requested' as const,
      requestedAt: '2026-09-24T15:00:00.000Z',
      completeBy: COMPLETE_BY,
      completedAt: null,
    },
  });

  it('[repro] a child deletion is answered with that child’s sentence, not the family’s', async () => {
    renderPage(<PrivacyControlsPage />, { api: fakeApi(undefined, () => accepted('child')) });
    const card = await screen.findByRole('group', { name: /delete a child’s data/i });
    await userEvent.selectOptions(within(card).getByLabelText(/child to delete/i), SAM);
    await userEvent.type(within(card).getByLabelText(/type sam to confirm/i), 'Sam');
    await userEvent.click(within(card).getByRole('button', { name: /delete sam’s data/i }));
    const target = { scope: 'child' as const, childId: SAM, nickname: 'Sam' };
    expect((await within(card).findByText(/deletion requested/i)).textContent).toBe(
      deletionRequestedMessage(target, portalDate(COMPLETE_BY)),
    );
    expect((await within(card).findByText(/deletion requested/i)).textContent).not.toBe(
      deletionRequestedMessage({ scope: 'family' }, portalDate(COMPLETE_BY)),
    );
  });

  it('a family deletion is answered with the family’s sentence', async () => {
    renderPage(<PrivacyControlsPage />, { api: fakeApi(undefined, () => accepted('family')) });
    const card = await screen.findByRole('group', { name: /delete your whole family account/i });
    await userEvent.type(within(card).getByLabelText(/type delete to confirm/i), 'DELETE');
    await userEvent.click(within(card).getByRole('button', { name: /delete our family account/i }));
    expect((await within(card).findByText(/deletion requested/i)).textContent).toBe(
      deletionRequestedMessage({ scope: 'family' }, portalDate(COMPLETE_BY)),
    );
  });
});
