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

/** Private object storage for homework pages (Supabase Storage in production). */
export interface StorageProvider {
  readonly name: string;
  readonly isMock: boolean;
  /** Signed, single-object upload URL; the client uploads bytes directly (never through the API). */
  createSignedUploadUrl(
    path: string,
    expiresInSeconds: number,
  ): Promise<{ url: string; expiresAt: Date }>;
  /** Short-lived signed read URL for an authorized viewer. */
  createSignedReadUrl(
    path: string,
    expiresInSeconds: number,
  ): Promise<{ url: string; expiresAt: Date }>;
  exists(path: string): Promise<boolean>;
  remove(paths: readonly string[]): Promise<void>;
}

/** Transactional email (guardian invitations, receipts of deletion requests). */
export interface EmailProvider {
  readonly name: string;
  readonly isMock: boolean;
  /** `templateKey` selects reviewed copy; `params` must never contain child homework or answers. */
  send(input: {
    to: string;
    templateKey: 'guardian_invitation' | 'deletion_received' | 'export_ready' | 'inactivity_notice';
    params: Record<string, string>;
  }): Promise<{ messageId: string }>;
}

export interface Providers {
  readonly consent: ConsentProvider;
  readonly storage: StorageProvider;
  readonly email: EmailProvider;
  readonly subscriptions: SubscriberStateProvider;
  readonly stripe: StripeBillingClient;
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

/** In-memory storage double for development/tests. Labeled mock; production readiness rejects it. */
export function createMemoryStorageMock(): StorageProvider & { readonly objects: Set<string> } {
  const objects = new Set<string>();
  return {
    name: 'memory_mock',
    isMock: true,
    objects,
    createSignedUploadUrl(path, expiresInSeconds) {
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
    remove(paths) {
      for (const p of paths) objects.delete(p);
      return Promise.resolve();
    },
  };
}

/** Records messages instead of sending them. Labeled mock. */
export function createOutboxEmailMock(): EmailProvider & {
  readonly outbox: { to: string; templateKey: string; params: Record<string, string> }[];
} {
  const outbox: { to: string; templateKey: string; params: Record<string, string> }[] = [];
  return {
    name: 'outbox_mock',
    isMock: true,
    outbox,
    send(input) {
      outbox.push(input);
      return Promise.resolve({ messageId: `mock-${outbox.length}` });
    },
  };
}
