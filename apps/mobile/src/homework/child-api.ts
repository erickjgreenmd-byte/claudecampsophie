/**
 * Device wiring for child homework requests: the API client carries the paired child's short-lived
 * access token (never a parent credential).
 *
 * BUG-012: this module used to run its own refresh-token rotation next to the family session. Two
 * refreshers on one device can present the same refresh token twice, which the server treats as
 * theft and answers by revoking the child's session. The app now has exactly one child session
 * (src/family/runtime.ts `childSession`, single-flight refresh), and every child client uses it.
 */
import { createMobileApi } from '../lib/api.ts';
import { withChildTokenRetry } from '../family/child-session.ts';
import { childSession } from '../family/runtime.ts';

/**
 * MOB-R2-02: a refusal with a cached token retries once through that one refresher, so a device
 * whose clock moved recovers instead of reporting itself unpaired. Still no second refresher.
 */
export const childApi = withChildTokenRetry(
  createMobileApi(childSession.accessToken),
  childSession,
);
