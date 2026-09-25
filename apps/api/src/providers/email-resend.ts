import { EMAIL_TEMPLATES, type EmailProvider, type EmailTemplateKey } from './index.ts';

/**
 * Transactional email through Resend (docs/Owner_Actions.md #14). The owner's domain stays at
 * GoDaddy: Resend only needs its DKIM/SPF records there. The Worker cannot speak SMTP, so a REST
 * provider is the only kind that can send from it.
 *
 * Fail-closed rules: only template keys with reviewed copy in EMAIL_TEMPLATES can be sent (a key
 * without copy is refused before any request); `params` are rendered by that copy alone, never
 * concatenated; the API key and sender are validated at construction so a wrong value is a
 * configuration error (NOT_CONFIGURED, LRD-4) and never a half-working provider. Nothing here has
 * run against Resend itself yet (no key in this environment): the request shape is `candidate`
 * until the first delivery is recorded in docs/Connections.md.
 */
export interface ResendEmailOptions {
  /** `re_…` API key; a secret, never logged. */
  readonly apiKey: string;
  /** Sender as `Name <mailbox@domain>` or `mailbox@domain`; the domain must be verified in Resend. */
  readonly from: string;
  readonly fetchImpl?: typeof fetch;
  readonly endpoint?: string;
  /** Per-request timeout; Resend answers in well under this. */
  readonly timeoutMs?: number;
}

export const RESEND_ENDPOINT = 'https://api.resend.com/emails';
export const MIN_RESEND_KEY_LENGTH = 20;

const FROM_PATTERN = /^(?:[^<>\r\n]{1,80}<)?[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}>?$/;

/** Why a configured key or sender would be refused; null when acceptable. */
export function resendKeyProblem(raw: string): string | null {
  const key = raw.trim();
  if (!key.startsWith('re_')) return 'must be a Resend API key (re_…)';
  if (key.length < MIN_RESEND_KEY_LENGTH)
    return `must be at least ${MIN_RESEND_KEY_LENGTH} characters`;
  if (!/^[A-Za-z0-9_]+$/.test(key)) return 'contains characters a Resend key never has';
  return null;
}

export function emailFromProblem(raw: string): string | null {
  const from = raw.trim();
  if (from === '') return 'required with RESEND_API_KEY';
  if (!FROM_PATTERN.test(from)) return 'must be `Name <mailbox@domain>` or `mailbox@domain`';
  if (from.includes('<') !== from.includes('>')) return 'unbalanced angle brackets';
  return null;
}

/** A provider answer other than success; `retryable` tells the job ledger whether to try again. */
export class EmailRequestError extends Error {
  readonly retryable: boolean;
  readonly status: number;
  constructor(status: number, retryable: boolean) {
    // The status only: a body could echo the address or the key.
    super(`resend: HTTP ${status}`);
    this.name = 'EmailRequestError';
    this.status = status;
    this.retryable = retryable;
  }
}

export class EmailTemplateMissingError extends Error {
  constructor(key: string) {
    super(`resend: no reviewed copy for template ${key}`);
    this.name = 'EmailTemplateMissingError';
  }
}

export function createResendEmail(options: ResendEmailOptions): EmailProvider {
  const keyProblem = resendKeyProblem(options.apiKey);
  if (keyProblem) throw new Error(`RESEND_API_KEY ${keyProblem}`);
  const fromProblem = emailFromProblem(options.from);
  if (fromProblem) throw new Error(`EMAIL_FROM ${fromProblem}`);
  const apiKey = options.apiKey.trim();
  const from = options.from.trim();
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint ?? RESEND_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    name: 'resend',
    isMock: false,
    async send(input: {
      to: string;
      templateKey: EmailTemplateKey;
      params: Record<string, string>;
    }): Promise<{ messageId: string }> {
      const template = EMAIL_TEMPLATES[input.templateKey];
      if (!template) throw new EmailTemplateMissingError(input.templateKey);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
            // One key per (template, recipient, params) so a retried job never sends twice.
            'idempotency-key': await idempotencyKey(input),
          },
          body: JSON.stringify({
            from,
            to: [input.to],
            subject: template.subject,
            text: template.body(input.params),
          }),
          signal: controller.signal,
        });
      } catch {
        // Network failure or timeout: nothing was confirmed sent, so the job may retry.
        throw new EmailRequestError(0, true);
      } finally {
        clearTimeout(timer);
      }
      if (response.status === 429 || response.status >= 500) {
        throw new EmailRequestError(response.status, true);
      }
      if (!response.ok) throw new EmailRequestError(response.status, false);
      const body = (await response.json().catch(() => null)) as { id?: unknown } | null;
      const id = body && typeof body.id === 'string' && body.id !== '' ? body.id : null;
      // Success without an id is not a recorded delivery: treat it as a final failure.
      if (!id) throw new EmailRequestError(response.status, false);
      return { messageId: id };
    },
  };
}

async function idempotencyKey(input: {
  to: string;
  templateKey: string;
  params: Record<string, string>;
}): Promise<string> {
  const material = JSON.stringify([
    input.templateKey,
    input.to.trim().toLowerCase(),
    Object.entries(input.params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
