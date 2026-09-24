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
