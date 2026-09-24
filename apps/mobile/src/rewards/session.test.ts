import { afterEach, describe, expect, it } from 'vitest';
import {
  childRewardsTokenSource,
  parentRewardsTokenSource,
  registerRewardsTokenSources,
} from './session.ts';

afterEach(() => {
  registerRewardsTokenSources({ child: null, parent: null });
});

describe('rewards token sources', () => {
  it('start unregistered so screens show "not connected" instead of calling the API', () => {
    expect(childRewardsTokenSource()).toBeNull();
    expect(parentRewardsTokenSource()).toBeNull();
  });

  it('keep child and parent sources separate', async () => {
    registerRewardsTokenSources({ child: () => Promise.resolve('child-token') });
    expect(await childRewardsTokenSource()!()).toBe('child-token');
    expect(parentRewardsTokenSource()).toBeNull();
    registerRewardsTokenSources({ parent: () => Promise.resolve('parent-token') });
    expect(await parentRewardsTokenSource()!()).toBe('parent-token');
    expect(await childRewardsTokenSource()!()).toBe('child-token');
  });
});
