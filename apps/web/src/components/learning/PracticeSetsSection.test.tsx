import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { practiceSetsResponseSchema } from '@pencillift/contracts';
import { type ParentPracticeSet } from '@pencillift/contracts';
import type { ApiClient } from '@pencillift/contracts/client';
import { renderPage } from '../../test/render.tsx';
import { PracticeSetsSection } from './PracticeSetsSection.tsx';

/**
 * API-AUTH-R2-04: the parent practice-set list was a hard cap of 30 newest-first, with no cursor, so
 * after about a month of daily sets the older ones — and the answer keys and review PDFs reached
 * through their ids — could not be listed at all. Synthetic data only.
 */

const CHILD = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';
const PAGE_SIZE = 30;

function setId(n: number): string {
  return `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;
}

/** A questionless ready daily set; the list only needs its title and date. */
function daily(n: number): ParentPracticeSet {
  const day = String((n % 28) + 1).padStart(2, '0');
  return {
    id: setId(n),
    kind: 'daily',
    status: 'ready',
    subjectKey: null,
    localDate: `2026-09-${day}`,
    reviewWeek: null,
    version: 1,
    optional: false,
    readyAt: '2026-09-20T15:00:00.000Z',
    releaseAt: '2026-09-20T15:00:00.000Z',
    mix: {},
    notes: [],
    items: [],
  };
}

const CURSOR = '1758380400000000_33333333-3333-4333-8333-000000000030';

function fakeApi() {
  const paths: string[] = [];
  const api: Partial<ApiClient> = {
    get: <S extends z.ZodType>(path: string, schema: S) => {
      paths.push(path);
      const older = path.includes('after=');
      const sets = older
        ? [daily(31), daily(32)]
        : Array.from({ length: PAGE_SIZE }, (_, i) => daily(i + 1));
      return Promise.resolve(
        schema.parse({ sets, nextCursor: older ? null : CURSOR } satisfies z.infer<
          typeof practiceSetsResponseSchema
        >),
      );
    },
  };
  return { api, paths };
}

function render(api: Partial<ApiClient>) {
  return renderPage(
    <PracticeSetsSection childId={CHILD} childName="Riley" subjects={[]} zone="America/Chicago" />,
    { api },
  );
}

afterEach(cleanup);

describe('[API-AUTH-R2-04] older practice sets stay reachable', () => {
  it('offers "Show older sets" while the API reports more and appends the next page', async () => {
    const user = userEvent.setup();
    const { api, paths } = fakeApi();
    render(api);
    await waitFor(() =>
      expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(PAGE_SIZE),
    );
    // No dead-end copy that simply admits the list is truncated.
    expect(screen.queryByText(/Showing the 30 most recent sets/i)).toBeNull();

    const older = screen.getByRole('button', { name: /show older sets/i });
    await user.click(older);

    await waitFor(() =>
      expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(PAGE_SIZE + 2),
    );
    expect(paths.at(-1)).toContain(`after=${encodeURIComponent(CURSOR)}`);
    // The last page has no cursor, so the control goes away rather than looping.
    expect(screen.queryByRole('button', { name: /show older sets/i })).toBeNull();
  });

  it('shows no paging control when the first page is the whole history', async () => {
    const api: Partial<ApiClient> = {
      get: <S extends z.ZodType>(_path: string, schema: S) =>
        Promise.resolve(schema.parse({ sets: [daily(1)], nextCursor: null })),
    };
    render(api);
    await screen.findByRole('heading', { level: 3 });
    expect(screen.queryByRole('button', { name: /show older sets/i })).toBeNull();
  });

  it('starts paging again from the first page when the filter changes', async () => {
    const user = userEvent.setup();
    const { api, paths } = fakeApi();
    render(api);
    await waitFor(() =>
      expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(PAGE_SIZE),
    );
    await user.click(screen.getByRole('button', { name: /show older sets/i }));
    await waitFor(() =>
      expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(PAGE_SIZE + 2),
    );

    await user.selectOptions(screen.getByLabelText('Show'), 'daily');
    await waitFor(() =>
      expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(PAGE_SIZE),
    );
    expect(paths.at(-1)).toBe(`/v1/children/${CHILD}/practice-sets?kind=daily`);
  });
});
