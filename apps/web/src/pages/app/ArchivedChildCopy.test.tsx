import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { renderPage } from '../../test/render.tsx';
import HomeworkPage from './HomeworkPage.tsx';
import LearningPlannerPage from './LearningPlannerPage.tsx';

/**
 * WEBR4-10: both child pickers spelled every non-active child " (no paid slot yet)" and the planner
 * added "{name} doesn't have a paid slot yet … see Subscription". That copy was written when 'draft'
 * was the only non-active state a portal user could reach; WEB-R2-03 makes 'archived' reachable in
 * one click (and a requested deletion archives a child too). For an archived child the sentence is
 * false — no slot is waiting to be bought, the profile is history only — and unactionable, while the
 * scan uploader was still offered although POST /v1/assignments answers CHILD_NOT_ACTIVE.
 *
 * Synthetic names only.
 */

const FAMILY = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
const RILEY = '6f1c2f0e-1f4b-4c8e-9b3a-2d3e4f5a6b7c';

const family = {
  id: FAMILY,
  displayName: 'Test Family',
  timezone: 'America/Chicago',
  paidSlots: 1,
  billingConflict: null,
  managingChannel: 'app_store',
  children: [{ id: RILEY, nickname: 'Riley', gradeLevel: 3, ageBand: '8-10', status: 'archived' }],
};

const emptyList = {
  assignments: [],
  allowance: {
    periodKey: 'pages:2026-09',
    childPagesUsed: 0,
    childPagesAllowed: 0,
    familyPagesUsed: 0,
    familyPagesAllowed: 40,
  },
  nextCursor: null,
};

function api(extra: (path: string) => unknown = () => undefined): Partial<ApiClient> {
  return {
    get: <S extends z.ZodType>(path: string, schema: S) => {
      const value =
        path === '/v1/family'
          ? family
          : path.startsWith('/v1/assignments?childId=')
            ? emptyList
            : extra(path);
      if (value === undefined) {
        return Promise.reject(new ApiRequestError('NOT_FOUND', `unexpected GET ${path}`, 404));
      }
      return Promise.resolve(schema.parse(value));
    },
    send: () => Promise.reject(new ApiRequestError('NOT_FOUND', 'unexpected send', 404)),
  };
}

afterEach(cleanup);

describe('[WEBR4-10] an archived child is never described as waiting for a paid slot', () => {
  it('labels the homework picker honestly and offers no scan uploader', async () => {
    renderPage(<HomeworkPage />, { api: api() });
    const picker = await screen.findByLabelText('Child');
    const option = within(picker).getByRole('option');
    expect(option.textContent).not.toMatch(/no paid slot yet/i);
    expect(option.textContent).toMatch(/archived/i);
    // The uploader would only reach CHILD_NOT_ACTIVE, and no client can assign a slot from there.
    expect(screen.queryByRole('region', { name: 'Add a scan' })).toBeNull();
  });

  it('labels the planner picker honestly and drops the "see Subscription" instruction', async () => {
    renderPage(<LearningPlannerPage />, {
      api: api((path) => (path.endsWith('/subjects') ? { subjects: [] } : undefined)),
    });
    const picker = await screen.findByLabelText('Child');
    const option = within(picker).getByRole('option');
    expect(option.textContent).not.toMatch(/no paid slot yet/i);
    expect(option.textContent).toMatch(/archived/i);
    const plan = await screen.findByRole('region', { name: /learning plan for riley/i });
    expect(plan.textContent).not.toMatch(/doesn’t have a paid slot yet/i);
    expect(plan.textContent).toMatch(/archived/i);
  });
});
