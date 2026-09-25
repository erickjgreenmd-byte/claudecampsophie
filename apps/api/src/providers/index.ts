import type { Db } from '../db.ts';
import type { StripeBillingClient, SubscriberStateProvider } from './billing.ts';

/**
 * External provider boundaries. Every implementation declares `isMock`; production readiness
 * (config.productionReadiness) and these adapters refuse mocks outside development/test.
 */

export interface ConsentStart {
  readonly providerReference: string;
  readonly redirectUrl: string | null;
}

export interface ConsentStatus {
  readonly status: 'pending' | 'verified' | 'failed';
  readonly method: string;
  readonly verifiedAt: Date | null;
}

/** Verifiable parental consent (spec P3). A checkbox or PIN can never produce `verified`. */
export interface ConsentProvider {
  readonly name: string;
  readonly isMock: boolean;
  start(input: {
    familyId: string;
    adultUserId: string;
    policyVersion: string;
  }): Promise<ConsentStart>;
  status(providerReference: string): Promise<ConsentStatus>;
}

/** What the API registered for an object before signing its upload (client-declared). */
export interface ExpectedUpload {
  readonly byteSize: number;
  readonly contentType: string;
}

/** What storage itself measured about a stored object — never a client-declared value. */
export interface StoredObjectInfo {
  readonly byteSize: number;
}

/** Private object storage for homework pages (Supabase Storage in production). */
export interface StorageProvider {
  readonly name: string;
  readonly isMock: boolean;
  /**
   * Signed, single-object upload URL; the client uploads bytes directly (never through the API).
   * `expected` is what the page was registered as. A backend that can bind a signed upload to a
   * length may use it; Supabase's signed-upload endpoint cannot (only the bucket-wide size and type
   * limits apply), so its adapter ignores it and finalize checks the result with `stat`.
   */
  createSignedUploadUrl(
    path: string,
    expiresInSeconds: number,
    expected?: ExpectedUpload,
  ): Promise<{ url: string; expiresAt: Date }>;
  /** Short-lived signed read URL for an authorized viewer. */
  createSignedReadUrl(
    path: string,
    expiresInSeconds: number,
  ): Promise<{ url: string; expiresAt: Date }>;
  exists(path: string): Promise<boolean>;
  /**
   * The stored object's measured size, or null when it is absent. Rejects when storage cannot say
   * (outage, or no size in its answer): callers must treat that as unavailable, never as a match.
   */
  stat(path: string): Promise<StoredObjectInfo | null>;
  remove(paths: readonly string[]): Promise<void>;
}

/**
 * The reviewed email templates. Every key selects copy the adapter owns; `params` never carry
 * child homework, answers, a child's name or a safety category (the safety flag email says only
 * that PencilLift flagged an answer and where to look).
 */
export const EMAIL_TEMPLATE_KEYS = [
  'guardian_invitation',
  'deletion_received',
  'export_ready',
  'inactivity_notice',
  'safety_flag',
] as const;
export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEYS)[number];

/** Release-readiness flag: the template copy below is a draft until approved. */
export const EMAIL_TEMPLATES_STATUS = 'draft_pending_owner_and_educator_approval' as const;

/**
 * The template table every adapter renders from (the outbox mock and Resend): subject and body for
 * the templates whose copy is written in this repository; a key without copy (`deletion_received`,
 * `export_ready`, unused today) is refused by the real adapter. DRAFTS: the owner and an educator must approve this wording before launch, like
 * the child safety templates (packages/domain safety/templates.ts). A real adapter (docs/Owner_Actions.md
 * #14) renders the same copy from the same key.
 *
 * `safety_flag` (owner decision, 2026-09-25: the parent is the only person PencilLift sends a
 * safety message to): sent to every active guardian when the safety screen flags a child's answer.
 * By design it names no child, quotes no homework and states no category; the parent reads the
 * flag in the portal's privacy page, where the child's notice and the two actions are explained.
 */
export const EMAIL_TEMPLATES: Readonly<
  Partial<
    Record<
      EmailTemplateKey,
      { readonly subject: string; readonly body: (params: Record<string, string>) => string }
    >
  >
> = {
  guardian_invitation: {
    subject: 'You’re invited to a PencilLift family account',
    body: (params) =>
      [
        'Hello,',
        '',
        `A parent has invited you to help manage the PencilLift family account “${params.familyName ?? 'their family'}”.`,
        'Guardians can see homework results and settings for the children in the family; the child area itself never needs an email address.',
        '',
        `Accept the invitation here: ${params.acceptUrl ?? ''}`,
        `This link expires at ${params.expiresAt ?? 'the time shown in the portal'} and works once.`,
        '',
        'If you were not expecting this, ignore this email; nothing is shared until the invitation is accepted.',
        '— PencilLift',
      ].join('\n'),
  },
  inactivity_notice: {
    subject: 'Your PencilLift family account has been inactive',
    body: (params) =>
      [
        'Hello,',
        '',
        `Nobody has used your PencilLift family account for a while. Unless someone signs in within the next ${params.days ?? '30'} days, the account and its children’s data will be deleted, as our privacy policy describes.`,
        '',
        'To keep the account, sign in to the PencilLift parent portal or open the app. To delete it now, use Privacy, export and deletion in the portal.',
        '',
        'This email names no child and quotes no homework.',
        '— PencilLift',
      ].join('\n'),
  },
  safety_flag: {
    subject: 'PencilLift flagged an answer for you to look at',
    body: (params) =>
      [
        'Hello,',
        '',
        'PencilLift’s safety check flagged one of the answers in a recent scan on your family account, so a grown-up can look at it.',
        'For that question, your child’s results show a calm message about talking with a grown-up they trust instead of a hint.',
        '',
        `Please sign in to the PencilLift parent portal and open Privacy & safety to see the flag and what you can do next: ${params.portalUrl ?? ''}`,
        '',
        'If your child may be in danger, call 911. Support is available any time from the 988 Suicide & Crisis Lifeline (call or text 988).',
        '',
        'This email names no child, quotes no homework and says nothing about the kind of concern; those details stay in your account.',
        '— PencilLift',
      ].join('\n'),
  },
};

/** Transactional email (guardian invitations, receipts of deletion requests, safety flags). */
export interface EmailProvider {
  readonly name: string;
  readonly isMock: boolean;
  /** `templateKey` selects reviewed copy; `params` must never contain child homework or answers. */
  send(input: {
    to: string;
    templateKey: EmailTemplateKey;
    params: Record<string, string>;
  }): Promise<{ messageId: string }>;
}

/**
 * Closes a parent's Supabase sign-in when they delete their account (Apple 5.1.1(v), Google Play
 * account deletion; POST /v1/account/close and the `account_close` job). A SOFT delete by design:
 * about forty columns reference auth.users without ON DELETE actions (migration 0830), so the row
 * stays with deleted_at set, its email and phone replaced, its metadata emptied and every session
 * ended. The pseudonymous id remains referable from the security log, billing and consent records.
 */
export interface AuthAdminProvider {
  readonly name: string;
  readonly isMock: boolean;
  /**
   * Idempotent: a user already closed, or unknown to the auth service, answers `already_closed`.
   * Rejects when the service could not be reached or refused (the job retries and dead-letters).
   */
  closeUser(userId: string): Promise<{ readonly outcome: 'closed' | 'already_closed' }>;
}

export interface Providers {
  readonly consent: ConsentProvider;
  readonly storage: StorageProvider;
  readonly email: EmailProvider;
  readonly subscriptions: SubscriberStateProvider;
  readonly stripe: StripeBillingClient;
  /**
   * Absent only in dependency sets built by hand (tests): the Worker always selects one
   * (src/index.ts selectAuthAdmin), and the account-close route and job fail closed without it.
   */
  readonly authAdmin: AuthAdminProvider;
}

/**
 * Development/test consent double. It is explicitly a mock: records it creates carry
 * is_test_provider = true and production readiness blocks while it is configured.
 */
export function createDevelopmentConsentMock(): ConsentProvider {
  return {
    name: 'development_mock',
    isMock: true,
    start({ familyId }) {
      return Promise.resolve({ providerReference: `mock-consent-${familyId}`, redirectUrl: null });
    },
    status() {
      return Promise.resolve({
        status: 'verified',
        method: 'development_mock',
        verifiedAt: new Date(0),
      });
    },
  };
}

/**
 * In-memory storage double for development/tests. Labeled mock; production readiness rejects it.
 * `put(path, bytes)` stores an object whose size `stat` measures from the bytes. The older
 * `objects.add(path)` shorthand models a device that uploaded exactly what it registered, so `stat`
 * reports the size declared when that upload was signed; with neither, `stat` rejects (no guess).
 */
export function createMemoryStorageMock(): StorageProvider & {
  readonly objects: Set<string>;
  put(path: string, bytes: Uint8Array): void;
} {
  const objects = new Set<string>();
  const measured = new Map<string, number>();
  const registered = new Map<string, number>();
  return {
    name: 'memory_mock',
    isMock: true,
    objects,
    put(path, bytes) {
      objects.add(path);
      measured.set(path, bytes.length);
    },
    createSignedUploadUrl(path, expiresInSeconds, expected) {
      if (expected) registered.set(path, expected.byteSize);
      return Promise.resolve({
        url: `https://storage.mock.invalid/upload/${encodeURIComponent(path)}`,
        expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
      });
    },
    createSignedReadUrl(path, expiresInSeconds) {
      return Promise.resolve({
        url: `https://storage.mock.invalid/read/${encodeURIComponent(path)}`,
        expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
      });
    },
    exists(path) {
      return Promise.resolve(objects.has(path));
    },
    stat(path) {
      if (!objects.has(path)) return Promise.resolve(null);
      const byteSize = measured.get(path) ?? registered.get(path);
      if (byteSize === undefined) {
        return Promise.reject(new Error('memory_mock: no size known for this object'));
      }
      return Promise.resolve({ byteSize });
    },
    remove(paths) {
      for (const p of paths) {
        objects.delete(p);
        measured.delete(p);
      }
      return Promise.resolve();
    },
  };
}

/**
 * Development/test double for the Supabase Auth Admin API. Labeled mock: never wired outside
 * development and test (src/index.ts), and the database function it calls refuses on a database
 * marked staging or production. It emulates GoTrue's soft delete on the local auth.users shim
 * (migration 0830 app.close_auth_user_locally): deleted_at set, email and phone replaced by a
 * pseudonym, metadata emptied, every session ended the way a sign-out ends it, step-ups revoked.
 * Takes the database lazily because the Worker selects providers before it opens a client.
 */
export function createLocalAuthAdminDouble(db: () => Db): AuthAdminProvider {
  return {
    name: 'local_double',
    isMock: true,
    async closeUser(userId) {
      const [row] = await db().asService(
        (tx) => tx<{ closed: boolean }[]>`
          select app.close_auth_user_locally(${userId}::uuid) as closed`,
      );
      return { outcome: row?.closed === true ? 'closed' : 'already_closed' };
    },
  };
}

export interface OutboxMessage {
  readonly to: string;
  readonly templateKey: string;
  readonly params: Record<string, string>;
  /** Rendered from EMAIL_TEMPLATES when the key has copy in this repository. */
  readonly subject?: string;
  readonly body?: string;
}

/**
 * Records messages instead of sending them, rendering the templates whose copy lives here so tests
 * can read what a guardian would. Labeled mock; never used outside development/test.
 */
export function createOutboxEmailMock(): EmailProvider & { readonly outbox: OutboxMessage[] } {
  const outbox: OutboxMessage[] = [];
  return {
    name: 'outbox_mock',
    isMock: true,
    outbox,
    send(input) {
      const template = EMAIL_TEMPLATES[input.templateKey];
      outbox.push(
        template
          ? { ...input, subject: template.subject, body: template.body(input.params) }
          : input,
      );
      return Promise.resolve({ messageId: `mock-${outbox.length}` });
    },
  };
}
