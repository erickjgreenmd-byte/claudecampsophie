// Independent adversarial review of the privacy vertical (REVIEW-PRIVACY): web parent privacy page.
// "[RV-privacy-<n>]" tests reproduce defects; "probe:" tests pin risky behaviour that held up.
// Synthetic data only (Riley, Sam).
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
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

function fakeApi(deletions: DeletionRequests = { requests: [] }): Partial<ApiClient> {
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
    send: () => Promise.reject(new Error('unexpected send')),
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
