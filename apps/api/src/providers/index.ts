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

export interface Providers {
  readonly consent: ConsentProvider;
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
