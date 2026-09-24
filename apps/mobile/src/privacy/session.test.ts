import { afterEach, describe, expect, it } from 'vitest';
import {
  childPrivacyTokenSource,
  parentPrivacyTokenSource,
  registerPrivacyTokenSources,
} from './session.ts';

afterEach(() => registerPrivacyTokenSources({ child: null, parent: null }));

describe('privacy token sources', () => {
  it('start unregistered so screens show an honest not-connected state', () => {
    expect(childPrivacyTokenSource()).toBeNull();
    expect(parentPrivacyTokenSource()).toBeNull();
  });

  it('keeps child and parent sources separate and lets either be cleared', async () => {
    registerPrivacyTokenSources({
      child: () => Promise.resolve('child-token'),
      parent: () => Promise.resolve('parent-token'),
    });
    expect(await childPrivacyTokenSource()!()).toBe('child-token');
    expect(await parentPrivacyTokenSource()!()).toBe('parent-token');
    registerPrivacyTokenSources({ parent: null });
    expect(parentPrivacyTokenSource()).toBeNull();
    expect(childPrivacyTokenSource()).not.toBeNull();
  });
});
