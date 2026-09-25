import type { ConsentStatus } from '@pencillift/contracts';

/**
 * Consent banner for the parent home screen (spec P3, AC_ACCESS_01/02). Honest about every state:
 * child-data processing stays off until a consent provider verifies an adult, and a development
 * test provider is always labelled as not real. Pure: no react-native imports.
 */

export type ConsentAction = 'start' | 'refresh' | 'none';

export interface ConsentBanner {
  /** `blocked` means homework checking is off because consent is not verified. */
  readonly tone: 'blocked' | 'ok';
  readonly title: string;
  readonly body: string;
  readonly testNote: string | null;
  readonly action: ConsentAction;
  readonly actionLabel: string | null;
  /**
   * A second, always-working way forward. While consent is pending this restarts it: the API
   * allows starting again, and it is the only way back when the parent closed the provider's page
   * or the API answers "Start consent again with the current provider" (RV-family-5).
   */
  readonly secondaryAction: ConsentAction;
  readonly secondaryLabel: string | null;
}

const TEST_RECORD_NOTE =
  'Test provider: this consent came from a development test service, not a real verification. It can’t enable processing of real children’s data in production.';
const TEST_ENVIRONMENT_NOTE =
  'Test environment: consent here uses a development test service and is not real verification.';

export function consentBanner(status: ConsentStatus | null): ConsentBanner {
  if (status === null) {
    return {
      tone: 'blocked',
      title: 'Consent status unavailable',
      body: 'We couldn’t check consent. Homework checking stays off until consent is confirmed.',
      testNote: null,
      action: 'none',
      actionLabel: null,
      secondaryAction: 'none',
      secondaryLabel: null,
    };
  }
  const testNote = status.isTestProvider
    ? TEST_RECORD_NOTE
    : status.state === 'none' && status.configuredProviderIsTest
      ? TEST_ENVIRONMENT_NOTE
      : null;
  switch (status.state) {
    case 'none':
      return {
        tone: 'blocked',
        title: 'Parental consent needed',
        body: 'A consent provider must verify an adult before your child can scan homework. A checkbox or your parent PIN can’t replace it.',
        testNote,
        action: 'start',
        actionLabel: 'Start consent',
        secondaryAction: 'none',
        secondaryLabel: null,
      };
    case 'pending':
      return {
        tone: 'blocked',
        title: 'Consent is waiting for verification',
        body: 'Finish the steps with the consent provider, then check the status here. Closed the provider’s page, or asked to start again? Start consent again: it replaces this waiting request.',
        testNote,
        action: 'refresh',
        actionLabel: 'Check status',
        secondaryAction: 'start',
        secondaryLabel: 'Start consent again',
      };
    case 'verified':
      return {
        tone: 'ok',
        title: 'Consent verified',
        body: 'PencilLift may process your children’s homework for learning feedback. You can withdraw consent in the parent portal.',
        testNote,
        action: 'none',
        actionLabel: null,
        secondaryAction: 'none',
        secondaryLabel: null,
      };
    case 'failed':
      return {
        tone: 'blocked',
        title: 'Consent could not be verified',
        body: 'Homework checking stays off. You can start consent again.',
        testNote,
        action: 'start',
        actionLabel: 'Start consent again',
        secondaryAction: 'none',
        secondaryLabel: null,
      };
    case 'withdrawn':
      return {
        tone: 'blocked',
        title: 'Consent was withdrawn',
        body: 'PencilLift won’t process new homework or build practice until consent is given again. Your children’s devices are signed out and can’t be paired until then; records already collected stay until you delete them.',
        testNote,
        action: 'start',
        actionLabel: 'Give consent again',
        secondaryAction: 'none',
        secondaryLabel: null,
      };
  }
}
