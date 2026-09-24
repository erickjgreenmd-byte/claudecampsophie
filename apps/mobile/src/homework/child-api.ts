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
import { childSession } from '../family/runtime.ts';

export const childApi = createMobileApi(childSession.accessToken);
