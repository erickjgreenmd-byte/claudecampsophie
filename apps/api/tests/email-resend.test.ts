import { describe, expect, it } from 'vitest';
import {
  createResendEmail,
  emailFromProblem,
  EmailRequestError,
  EmailTemplateMissingError,
  RESEND_ENDPOINT,
  resendKeyProblem,
} from '../src/providers/email-resend.ts';
import { EMAIL_TEMPLATES } from '../src/providers/index.ts';

/**
 * The Resend adapter against a FAKE fetch (labeled: nothing here reaches Resend; the request shape
 * is `candidate` until the first real delivery is recorded in docs/Connections.md).
 */
const KEY = 're_test_key_value_not_real_1234567890';
const FROM = 'PencilLift <hello@pencillift.test>';

function fakeFetch(
  status: number,
  body: unknown,
): { calls: { url: string; init: RequestInit }[]; fetchImpl: typeof fetch } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    calls.push({ url: href, init: init ?? {} });
    return Promise.resolve(
      new Response(body === null ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('Resend email adapter (labeled fake fetch)', () => {
  it('refuses a key or sender it cannot use at construction (LRD-4)', () => {
    expect(resendKeyProblem('sk_live_wrong')).toMatch(/re_/);
    expect(resendKeyProblem('re_short')).toMatch(/at least/);
    expect(resendKeyProblem(KEY)).toBeNull();
    expect(emailFromProblem('')).toMatch(/required/);
    expect(emailFromProblem('not an address')).toMatch(/Name <mailbox@domain>/);
    expect(emailFromProblem('hello@pencillift.test')).toBeNull();
    expect(emailFromProblem(FROM)).toBeNull();
    expect(() => createResendEmail({ apiKey: 'nope', from: FROM })).toThrow(/RESEND_API_KEY/);
    expect(() => createResendEmail({ apiKey: KEY, from: 'x' })).toThrow(/EMAIL_FROM/);
  });

  it('sends reviewed copy only: subject and text come from EMAIL_TEMPLATES, never from params', async () => {
    const { calls, fetchImpl } = fakeFetch(200, { id: 'msg_123' });
    const email = createResendEmail({ apiKey: KEY, from: FROM, fetchImpl });
    const result = await email.send({
      to: 'Parent@Example.test',
      templateKey: 'safety_flag',
      params: { portalUrl: 'https://portal.pencillift.test', injected: 'Riley wrote 2+2=5' },
    });
    expect(result).toEqual({ messageId: 'msg_123' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(RESEND_ENDPOINT);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(headers['idempotency-key']).toMatch(/^[0-9a-f]{64}$/);
    const raw = calls[0]!.init.body;
    expect(typeof raw).toBe('string');
    const body = JSON.parse(raw as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      from: FROM,
      to: ['Parent@Example.test'],
      subject: EMAIL_TEMPLATES.safety_flag!.subject,
    });
    expect(String(body['text'])).toContain('https://portal.pencillift.test');
    // A param the template does not use never reaches the email (no concatenation of inputs).
    expect(JSON.stringify(body)).not.toContain('Riley');
    expect(body['html']).toBeUndefined();
  });

  it('the idempotency key is stable for the same recipient, template and params and differs otherwise', async () => {
    const { calls, fetchImpl } = fakeFetch(200, { id: 'msg_1' });
    const email = createResendEmail({ apiKey: KEY, from: FROM, fetchImpl });
    const send = (to: string, portalUrl: string) =>
      email.send({ to, templateKey: 'safety_flag', params: { portalUrl } });
    await send('a@example.test', 'https://p.test');
    await send('A@example.test ', 'https://p.test');
    await send('a@example.test', 'https://other.test');
    const keys = calls.map((c) => (c.init.headers as Record<string, string>)['idempotency-key']);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).not.toBe(keys[2]);
  });

  it('refuses a template key without reviewed copy before any request', async () => {
    const { calls, fetchImpl } = fakeFetch(200, { id: 'msg_1' });
    const email = createResendEmail({ apiKey: KEY, from: FROM, fetchImpl });
    await expect(
      email.send({ to: 'a@example.test', templateKey: 'export_ready', params: {} }),
    ).rejects.toBeInstanceOf(EmailTemplateMissingError);
    expect(calls).toHaveLength(0);
  });

  it('classifies answers: 429 and 5xx retryable, other 4xx final, success without an id final', async () => {
    const attempt = async (status: number, body: unknown) => {
      const { fetchImpl } = fakeFetch(status, body);
      const email = createResendEmail({ apiKey: KEY, from: FROM, fetchImpl });
      try {
        await email.send({
          to: 'a@example.test',
          templateKey: 'safety_flag',
          params: { portalUrl: 'x' },
        });
        return 'ok';
      } catch (error) {
        if (error instanceof EmailRequestError) return `${error.status}:${error.retryable}`;
        throw error;
      }
    };
    expect(await attempt(429, { message: 'slow down' })).toBe('429:true');
    expect(await attempt(503, null)).toBe('503:true');
    expect(await attempt(401, { message: 'bad key' })).toBe('401:false');
    expect(await attempt(422, { message: 'domain not verified' })).toBe('422:false');
    expect(await attempt(200, { ok: true })).toBe('200:false');
  });

  it('a network failure or timeout is retryable and names no address or key', async () => {
    const fetchImpl = (() => Promise.reject(new Error('socket hang up'))) as typeof fetch;
    const email = createResendEmail({ apiKey: KEY, from: FROM, fetchImpl });
    let failure: unknown;
    try {
      await email.send({
        to: 'secret-parent@example.test',
        templateKey: 'safety_flag',
        params: { portalUrl: 'x' },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(EmailRequestError);
    const typed = failure as EmailRequestError;
    expect(typed.retryable).toBe(true);
    expect(typed.message).not.toMatch(/secret-parent|re_test/);
  });

  it('every template the code sends has reviewed copy; each body names no child and quotes no homework', () => {
    for (const key of ['guardian_invitation', 'inactivity_notice', 'safety_flag'] as const) {
      const template = EMAIL_TEMPLATES[key];
      expect(template, key).toBeDefined();
      // Sentinel params a caller must never be able to smuggle into an email: a child's name, a
      // homework answer, a category. The copy renders only the params it names.
      const body = template!.body({
        portalUrl: 'https://p.test',
        acceptUrl: 'https://p.test/accept',
        familyName: 'The Demo Family',
        expiresAt: '2026-10-01T00:00:00.000Z',
        days: '30',
        childName: 'Riley',
        answerText: '2+2=5',
        category: 'self_harm',
      });
      expect(body).not.toMatch(/Riley|2\+2=5|self_harm/);
      expect(body.length).toBeLessThan(2000);
    }
  });
});
