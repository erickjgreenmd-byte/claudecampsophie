import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { z } from 'zod';
import {
  IDENTITY_ATTESTATION_REQUIRED_COPY,
  IDENTITY_ATTESTATION_STATEMENT,
  IDENTITY_ATTESTATION_VERSION,
  IDENTITY_BASIS_COPY,
  IDENTITY_FACE_CHECK_COPY,
  IDENTITY_FAILURE_FALLBACK,
  IDENTITY_FAILURE_CODES,
  IDENTITY_IMAGE_MAX_BYTES,
  IDENTITY_IMAGE_REJECTION_COPY,
  IDENTITY_REQUEST_FAILURE_COPY,
  IDENTITY_REQUIREMENT_COPY,
  IDENTITY_SCREEN_COPY,
  identityFailureCopy,
  identityFailureIsOurs,
  identityRetryWorthwhile,
  type IdentityVerificationStatus,
} from '@pencillift/contracts';
import { ApiRequestError, type ApiClient } from '@pencillift/contracts/client';
import { renderPage } from '../../test/render.tsx';
import IdentityPage from './IdentityPage.tsx';

/**
 * The portal's adult ID screen (spec P3 verifiable parental consent, AC_ACCESS_01/02; migration
 * 0990). The phone's equivalent is `apps/mobile/src/identity/identity-form.ts` and its own suite,
 * `identity-form.test.ts` — the screen that renders it, `app/(parent)/identity.tsx`, imports
 * react-native and cannot be rendered by any test in this repository.
 *
 * NEITHER SUITE READS THE OTHER'S SOURCE. Every sentence asserted here is imported from
 * `@pencillift/contracts`, and the phone's suite imports the same constants, so a mutation of one of
 * them reddens both. That is the evidence L-070 asks for: a test that greps the other surface's file
 * guards the words and not the meaning, and this round refused one.
 *
 * Synthetic adults only; the "ID photo" is a 1x1 PNG.
 */

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);

function pngFile(name = 'licence.png'): File {
  return new File([PNG_BYTES], name, { type: 'image/png' });
}

function status(over: Partial<IdentityVerificationStatus> = {}): IdentityVerificationStatus {
  return {
    confirmed: false,
    basis: null,
    latest: null,
    attestationVersionRequired: IDENTITY_ATTESTATION_VERSION,
    faceCheckAvailable: false,
    ...over,
  };
}

function refused(code: string | null): IdentityVerificationStatus {
  return status({
    latest: {
      id: '11111111-1111-4111-8111-111111111111',
      checkedAt: '2026-09-30T12:00:00.000Z',
      provider: 'test-provider',
      documentIsGovernmentId: false,
      documentHolderIsAdult: false,
      faceMatch: 'not_attempted',
      holderAttestationVersion: null,
      failureCode: code as never,
      isTestProvider: true,
    },
  });
}

/**
 * Renders the page over a fake API and records every POST body.
 *
 * Both answers go through the REAL `identityVerificationStatusSchema`, as the app's client does, so
 * a fixture this file invents that the contract would refuse fails here rather than passing on a
 * shape the server cannot send.
 */
function mount(
  first: IdentityVerificationStatus,
  answer?: (body: unknown) => IdentityVerificationStatus,
) {
  const bodies: unknown[] = [];
  const settle = <S extends z.ZodType>(value: unknown, schema: S): Promise<z.output<S>> => {
    try {
      return Promise.resolve(schema.parse(value));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const api: Partial<ApiClient> = {
    get: <S extends z.ZodType>(_path: string, schema: S) => settle(first, schema),
    send: <S extends z.ZodType>(
      _method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      _path: string,
      body: unknown,
      schema: S,
    ) => {
      bodies.push(body);
      if (!answer) return Promise.reject(new Error('unexpected POST'));
      return settle(answer(body), schema);
    },
  };
  const view = renderPage(<IdentityPage />, { api });
  return { ...view, bodies };
}

afterEach(cleanup);

async function waitForForm(): Promise<HTMLElement> {
  return await screen.findByRole('button', { name: IDENTITY_SCREEN_COPY.submitLabel });
}

describe('the declaration is presented as a statement being made (0990)', () => {
  it('shows IDENTITY_ATTESTATION_STATEMENT in full, as the label of the control that affirms it', async () => {
    mount(status());
    const box = await screen.findByRole('checkbox', { name: IDENTITY_ATTESTATION_STATEMENT });
    expect(box).toBeTruthy();
    expect(screen.getByText(IDENTITY_ATTESTATION_STATEMENT)).toBeTruthy();
  });

  it('never asks for a selfie, and never mentions one', async () => {
    mount(status());
    await waitForForm();
    expect(document.body.textContent ?? '').not.toMatch(
      /selfie|face photo|photo of yourself|front camera/i,
    );
    // Nor does the file input invite a second image.
    expect(screen.getAllByLabelText(/photo/i).length).toBeGreaterThan(0);
    expect(document.querySelectorAll('input[type="file"]').length).toBe(1);
  });

  it('states whether the stronger standard can be met, before a parent submits (L-068)', async () => {
    mount(status({ faceCheckAvailable: false }));
    await waitForForm();
    expect(screen.getByText(IDENTITY_FACE_CHECK_COPY.unavailable)).toBeTruthy();
  });

  it('states it again on the success state, in the same sentence', async () => {
    mount(status({ confirmed: true, basis: 'declared', faceCheckAvailable: false }));
    await screen.findByText(IDENTITY_BASIS_COPY.declared.headline);
    expect(screen.getByText(IDENTITY_FACE_CHECK_COPY.unavailable)).toBeTruthy();
  });
});

describe('enforcement happens on submit and reports EVERY unmet requirement (L-059)', () => {
  it('the submit button is NOT disabled when nothing has been filled in', async () => {
    mount(status());
    const submit = await waitForForm();
    expect(submit.hasAttribute('disabled')).toBe(false);
  });

  it('an empty form is refused with all three reasons, and nothing is sent', async () => {
    const { bodies } = mount(status());
    const submit = await waitForForm();
    await userEvent.click(submit);
    await screen.findByText(IDENTITY_REQUIREMENT_COPY.document);
    expect(screen.getByText(IDENTITY_REQUIREMENT_COPY.dateOfBirth)).toBeTruthy();
    expect(screen.getByText(IDENTITY_ATTESTATION_REQUIRED_COPY)).toBeTruthy();
    expect(bodies).toEqual([]);
  });

  /**
   * Found by reading the page back after the suite above was green, which is why it is here: the
   * `aria-describedby` on the photo input named the INPUT'S OWN id, and the other two controls had
   * none at all. Three reasons were on screen and a screen-reader user reached none of them from
   * the control each was about — the L-059 defect in its assistive-technology form, where the
   * reason exists but not where the parent is standing.
   */
  it('each field’s reason is announced by the control it is about', async () => {
    mount(status());
    const submit = await waitForForm();
    await userEvent.click(submit);
    await screen.findByText(IDENTITY_REQUIREMENT_COPY.document);
    const pairs: readonly (readonly [HTMLElement, string])[] = [
      [
        screen.getByLabelText(IDENTITY_SCREEN_COPY.documentLabel),
        IDENTITY_REQUIREMENT_COPY.document,
      ],
      [
        screen.getByLabelText(IDENTITY_SCREEN_COPY.dateOfBirthLabel),
        IDENTITY_REQUIREMENT_COPY.dateOfBirth,
      ],
      [
        screen.getByRole('checkbox', { name: IDENTITY_ATTESTATION_STATEMENT }),
        IDENTITY_ATTESTATION_REQUIRED_COPY,
      ],
    ];
    for (const [control, reason] of pairs) {
      const described = control.getAttribute('aria-describedby');
      expect(described, reason).toBeTruthy();
      const target = described === null ? null : globalThis.document.getElementById(described);
      expect(target?.textContent, reason).toBe(reason);
    }
  });

  it('a parent missing the date AND the declaration sees BOTH reasons in one pass', async () => {
    const { bodies } = mount(status());
    const submit = await waitForForm();
    await userEvent.upload(screen.getByLabelText(IDENTITY_SCREEN_COPY.documentLabel), pngFile());
    await screen.findByText(IDENTITY_SCREEN_COPY.documentChosen);
    await userEvent.click(submit);
    await screen.findByText(IDENTITY_REQUIREMENT_COPY.dateOfBirth);
    expect(screen.getByText(IDENTITY_ATTESTATION_REQUIRED_COPY)).toBeTruthy();
    expect(screen.queryByText(IDENTITY_REQUIREMENT_COPY.document)).toBeNull();
    expect(bodies).toEqual([]);
  });
});

describe('the image goes into the request body and nowhere else', () => {
  it('sends base64 with no data URL prefix, beside its mime type', async () => {
    const { bodies } = mount(status(), () => status({ confirmed: true, basis: 'declared' }));
    const submit = await waitForForm();
    await userEvent.upload(screen.getByLabelText(IDENTITY_SCREEN_COPY.documentLabel), pngFile());
    await screen.findByText(IDENTITY_SCREEN_COPY.documentChosen);
    await userEvent.type(
      screen.getByLabelText(IDENTITY_SCREEN_COPY.dateOfBirthLabel),
      '1990-04-12',
    );
    await userEvent.click(screen.getByRole('checkbox', { name: IDENTITY_ATTESTATION_STATEMENT }));
    await userEvent.click(submit);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      statedDateOfBirth: '1990-04-12',
      document: { mimeType: 'image/png', base64: 'iVBORw0KGgoBAgME' },
      holderAttestation: true,
    });
    const sent = JSON.stringify(bodies[0]);
    expect(sent).not.toMatch(/data:/);
  });

  it('refuses a photo over IDENTITY_IMAGE_MAX_BYTES on choosing it, naming the action', async () => {
    const { bodies } = mount(status());
    await waitForForm();
    const big = new File([new Uint8Array(IDENTITY_IMAGE_MAX_BYTES + 1)], 'big.png', {
      type: 'image/png',
    });
    await userEvent.upload(screen.getByLabelText(IDENTITY_SCREEN_COPY.documentLabel), big);
    await screen.findByText(IDENTITY_IMAGE_REJECTION_COPY.tooLarge);
    // Nothing was kept, so a submit still reports the document as missing rather than sending it.
    await userEvent.click(screen.getByRole('button', { name: IDENTITY_SCREEN_COPY.submitLabel }));
    await screen.findByText(IDENTITY_REQUIREMENT_COPY.document);
    expect(bodies).toEqual([]);
  });

  it('refuses a mime type the check cannot read', async () => {
    mount(status());
    await waitForForm();
    const heic = new File([PNG_BYTES], 'ID.heic', { type: 'image/heic' });
    // `applyAccept: false` on purpose. The input's `accept` is a filter the picker OFFERS, not one it
    // enforces — every desktop file dialog has an "All files" escape and an iPhone hands over
    // whatever the share sheet gave it — so the client-side check has to stand on its own. A test
    // that let `accept` do the refusing would pass while the check underneath it was deleted.
    await userEvent.upload(screen.getByLabelText(IDENTITY_SCREEN_COPY.documentLabel), heic, {
      applyAccept: false,
    });
    await screen.findByText(IDENTITY_IMAGE_REJECTION_COPY.mimeType);
  });
});

describe('a refusal is worded by the contract, and the retry follows identityFailureIsOurs', () => {
  it('DOB_MISMATCH: the contract sentence, with the form still there to fix', async () => {
    mount(refused('DOB_MISMATCH'));
    await screen.findByText(identityFailureCopy('DOB_MISMATCH'));
    expect(screen.getByRole('button', { name: IDENTITY_SCREEN_COPY.submitLabel })).toBeTruthy();
  });

  it('ATTESTATION_REQUIRED keeps the form, because the parent can always fix it', async () => {
    mount(refused('ATTESTATION_REQUIRED'));
    await screen.findByText(identityFailureCopy('ATTESTATION_REQUIRED'));
    expect(screen.getByRole('checkbox', { name: IDENTITY_ATTESTATION_STATEMENT })).toBeTruthy();
    expect(screen.getByRole('button', { name: IDENTITY_SCREEN_COPY.submitLabel })).toBeTruthy();
  });

  it('PROVIDER_UNAVAILABLE is ours: no submit control at all, and support instead', async () => {
    mount(refused('PROVIDER_UNAVAILABLE'));
    await screen.findByText(identityFailureCopy('PROVIDER_UNAVAILABLE'));
    expect(screen.queryByRole('button', { name: IDENTITY_SCREEN_COPY.submitLabel })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText(IDENTITY_SCREEN_COPY.supportLabel)).toBeTruthy();
  });

  it('a row that does not say why reaches IDENTITY_FAILURE_FALLBACK, not the nearest guess (L-057)', async () => {
    mount(refused(null));
    await screen.findByText(IDENTITY_FAILURE_FALLBACK);
    expect(screen.queryByRole('button', { name: IDENTITY_SCREEN_COPY.submitLabel })).toBeNull();
  });

  /**
   * PREMISE CORRECTED WHILE WRITING THIS FILE, and worth the paragraph.
   *
   * The case above was first written with a made-up code ('A_CODE_THIS_BUILD_HAS_NEVER_HEARD_OF').
   * It passes in the phone's unit test, which builds the status object directly, and it FAILED here
   * — because the portal's answer goes through `identityVerificationStatusSchema`, whose
   * `latest.failureCode` is `z.enum(IDENTITY_FAILURE_CODES)`. A code this build does not know cannot
   * reach either screen as a refusal at all: the client rejects the whole response first.
   *
   * So the honest question is what the parent sees THEN — and the answer has to be the fall-through
   * too, never a guessed remedy. It is, because the unreadable answer goes through
   * `identityRequestFailureCopy`'s default.
   */
  it('a code outside the contract’s enum is refused as a response, and still lands honestly', async () => {
    mount(refused('A_CODE_THIS_BUILD_HAS_NEVER_HEARD_OF'));
    await screen.findByText(IDENTITY_REQUEST_FAILURE_COPY.unknown);
    expect(screen.queryByRole('button', { name: IDENTITY_SCREEN_COPY.submitLabel })).toBeNull();
  });
});

describe('the success state names the BASIS honestly', () => {
  it('a declared basis is never called verified', async () => {
    mount(status({ confirmed: true, basis: 'declared' }));
    await screen.findByText(IDENTITY_BASIS_COPY.declared.headline);
    expect(screen.getByText(IDENTITY_BASIS_COPY.declared.detail)).toBeTruthy();
    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading.textContent ?? '').not.toMatch(/\bverified\b/i);
    expect(screen.queryByText(IDENTITY_BASIS_COPY.verified.headline)).toBeNull();
  });

  it('a verified basis says so', async () => {
    mount(status({ confirmed: true, basis: 'verified', faceCheckAvailable: true }));
    await screen.findByText(IDENTITY_BASIS_COPY.verified.headline);
    expect(screen.getByText(IDENTITY_FACE_CHECK_COPY.available)).toBeTruthy();
  });

  it('shows the answer the POST came back with, not the one the page hoped for', async () => {
    const { bodies } = mount(status(), () => refused('DOCUMENT_UNREADABLE'));
    const submit = await waitForForm();
    await userEvent.upload(screen.getByLabelText(IDENTITY_SCREEN_COPY.documentLabel), pngFile());
    await screen.findByText(IDENTITY_SCREEN_COPY.documentChosen);
    await userEvent.type(
      screen.getByLabelText(IDENTITY_SCREEN_COPY.dateOfBirthLabel),
      '1990-04-12',
    );
    await userEvent.click(screen.getByRole('checkbox', { name: IDENTITY_ATTESTATION_STATEMENT }));
    await userEvent.click(submit);
    await waitFor(() => expect(bodies).toHaveLength(1));
    await screen.findByText(identityFailureCopy('DOCUMENT_UNREADABLE'));
    expect(screen.queryByText(IDENTITY_BASIS_COPY.declared.headline)).toBeNull();
  });
});

describe('a request that could not be made', () => {
  it('is worded by the contract, and leaves the form in place to try again', async () => {
    const bodies: unknown[] = [];
    renderPage(<IdentityPage />, {
      api: {
        get: <S extends z.ZodType>(_path: string, schema: S) =>
          Promise.resolve(schema.parse(status())),
        send: (_method, _path, body) => {
          bodies.push(body);
          return Promise.reject(new ApiRequestError('NETWORK', 'offline', 0));
        },
      },
    });
    const submit = await waitForForm();
    await userEvent.upload(screen.getByLabelText(IDENTITY_SCREEN_COPY.documentLabel), pngFile());
    await screen.findByText(IDENTITY_SCREEN_COPY.documentChosen);
    await userEvent.type(
      screen.getByLabelText(IDENTITY_SCREEN_COPY.dateOfBirthLabel),
      '1990-04-12',
    );
    await userEvent.click(screen.getByRole('checkbox', { name: IDENTITY_ATTESTATION_STATEMENT }));
    await userEvent.click(submit);
    await waitFor(() => expect(bodies).toHaveLength(1));
    await screen.findByText(IDENTITY_REQUEST_FAILURE_COPY.offline);
    expect(screen.getByRole('button', { name: IDENTITY_SCREEN_COPY.submitLabel })).toBeTruthy();
  });
});

/**
 * PROPERTIES OF THE SENTENCES, not their text — the same set the phone's suite carries
 * (`identity-form.test.ts`), so a reworded line has to satisfy both surfaces or neither.
 *
 * WHY THESE EXIST. The first version of both suites asserted each line by importing the constant and
 * comparing it with itself, and a mutation check proved those assertions worthless: rewriting
 * `IDENTITY_REQUIREMENT_COPY.document` to 'A photo of your ID is needed.' — a line naming no action
 * — reddened NOTHING anywhere, because the expected value moved with the actual. Equality with an
 * imported constant pins WHERE a sentence comes from; only a property pins what it has to say.
 */
describe('the properties every line of this screen has to keep', () => {
  it('every unmet-requirement line opens with something the parent can do', () => {
    for (const [field, line] of Object.entries(IDENTITY_REQUIREMENT_COPY)) {
      expect(line, field).toMatch(/^(Add|Take|Choose|Enter|Photograph|Please confirm)\b/);
    }
  });

  it('every refused-photo line names an action, and the one that is ours says so', () => {
    for (const [reason, line] of Object.entries(IDENTITY_IMAGE_REJECTION_COPY)) {
      expect(line, reason).toMatch(/\b(take|choose|try)\b/i);
    }
    expect(IDENTITY_IMAGE_REJECTION_COPY.unsendable).toMatch(/on us/i);
    expect(IDENTITY_IMAGE_REJECTION_COPY.tooLarge).toMatch(
      new RegExp(String(IDENTITY_IMAGE_MAX_BYTES / (1024 * 1024))),
    );
  });

  it('the declaration on screen still says all four things it exists to say', async () => {
    mount(status());
    const box = await screen.findByRole('checkbox');
    const printed = box.getAttribute('aria-label') ?? box.closest('label')?.textContent ?? '';
    expect(printed).toMatch(/person shown on this document/i);
    expect(printed).toMatch(/18 years old/);
    expect(printed).toMatch(/parent or legal guardian/i);
    expect(printed).toMatch(/legal declaration/i);
  });

  /**
   * Over the whole SET of codes rather than the interesting ones (L-057), so a code added later is
   * carried the day the enum grows instead of being a case nobody wrote.
   */
  /**
   * WHAT DECIDES IT IS `identityRetryWorthwhile`, NOT `identityFailureIsOurs`. This case asserted
   * the second and went red when the contract split the two questions apart — correctly, because it
   * had encoded the defect: `PROVIDER_ERROR` is ours AND retryable, and under the old rule its copy
   * told the parent "Please try again" on a screen that had just removed the button.
   *
   * The phone's `identity-form.test.ts` carries the same property in the same words, because the
   * rule is one rule (`identityOutcome`) and a property that holds on one surface only is how seven
   * of round 7's sixty findings happened (L-070).
   */
  it('every code keeps the form exactly where trying again could help', async () => {
    for (const code of IDENTITY_FAILURE_CODES) {
      mount(refused(code));
      await screen.findByText(identityFailureCopy(code));
      const submit = screen.queryByRole('button', { name: IDENTITY_SCREEN_COPY.submitLabel });
      if (identityRetryWorthwhile(code)) {
        expect(submit, code).toBeTruthy();
      } else {
        expect(submit, code).toBeNull();
        expect(screen.getByText(IDENTITY_SCREEN_COPY.supportLabel), code).toBeTruthy();
      }
      // The words and the control agree, which is the invariant the split exists to keep.
      if (/try again/i.test(identityFailureCopy(code))) {
        expect(submit, `${code} says "try again"`).toBeTruthy();
      }
      // And a refusal that is OURS says so wherever it lands, blocked or not: the tone is the other
      // question the one predicate used to answer (L-076).
      if (identityFailureIsOurs(code)) {
        expect(identityFailureCopy(code), code).toMatch(/on us|on our side|support/i);
      }
      cleanup();
    }
  });
});

/**
 * THE LAST LOCAL SENTENCE, caught by grepping both surfaces for capitalised string literals after
 * everything else was green — and the two had ALREADY diverged, one with an ellipsis and one
 * without, inside a single change written by one owner in one sitting. That is how small the gap
 * is that L-070's seven findings came through: nobody writes the second sentence on purpose.
 */
describe('the “still loading” line', () => {
  it('comes from the shared constant, so the phone cannot word it differently', async () => {
    renderPage(<IdentityPage />, { api: { get: () => new Promise(() => undefined) } });
    const shown = await screen.findByText(IDENTITY_SCREEN_COPY.loadingLabel);
    // Equality pins WHERE the line comes from; the property pins what it has to say. Without the
    // second line a mutation check proved this case worthless — rewriting the constant to 'Please
    // wait.' reddened the phone and not the portal, because here the expectation moved with it.
    expect(shown.textContent).toMatch(/record/i);
  });
});

/**
 * THE PHONE'S THREE CASES, in the portal's words. Each was proved worth having by a mutation that
 * reddened the phone's suite and not this one — which is the L-070 shape exactly: the fix reaches
 * one surface, the property reaches one surface, and the gap is invisible because both suites are
 * green. `identity-form.test.ts` carries the same three.
 */
describe('the states the portal used to assert nothing about', () => {
  it('a confirmed adult with no stated basis is never told a face check ran', async () => {
    // Mutating `identityOutcome`'s `status.basis ?? 'unstated'` to `?? 'verified'` reddened nothing
    // here. A family established before either table recorded a basis would have read "a face check
    // confirmed it is yours" about a check that never ran (L-057).
    mount(status({ confirmed: true, basis: null }));
    await screen.findByText(IDENTITY_BASIS_COPY.unstated.headline);
    const main = document.body.textContent ?? '';
    expect(main).not.toMatch(/face check/i);
    expect(main).not.toMatch(/\bverif(y|ied|ication)\b/i);
    expect(screen.queryByText(IDENTITY_BASIS_COPY.verified.headline)).toBeNull();
    expect(screen.queryByText(IDENTITY_BASIS_COPY.declared.headline)).toBeNull();
  });

  it('a submit with no photo names the PHOTO, beside the photo control', async () => {
    const submit = await (async () => {
      mount(status());
      return await waitForForm();
    })();
    // Nothing chosen, nothing typed: the submit reports every unmet requirement at once (L-059),
    // and this reads the one no case read — the sentence a parent who taps too early sees first.
    await userEvent.click(submit);
    const shown = await screen.findByText(IDENTITY_REQUIREMENT_COPY.document);
    expect(shown).toBeTruthy();
    const control = screen.getByLabelText(IDENTITY_SCREEN_COPY.documentLabel);
    // The reason is wired to the control it belongs beside, not merely present on the page.
    expect(control.getAttribute('aria-describedby') ?? '').toContain(shown.id);
    expect(IDENTITY_REQUIREMENT_COPY.document).toMatch(/photo|ID/i);
  });

  /**
   * OVER EVERY STATE, not the two that were interesting. The portal had no selfie-negative at all;
   * the phone's covered the empty form and one success, so a selfie prompt reintroduced on a
   * REFUSAL — where a parent who cannot get past the check spends the most time — would have
   * shipped with both suites green. `FACE_NOT_CONFIRMED` is the stated exemption: it is the
   * stronger standard's refusal and its words are about a selfie by necessity.
   */
  it('never asks for a selfie in any state, and only the face refusal may mention one', async () => {
    const selfieWords = /selfie|face photo|photo of yourself|front camera/i;
    const screens: [string, IdentityVerificationStatus][] = [
      ['not started', status()],
      ['declared', status({ confirmed: true, basis: 'declared' })],
      ['unstated', status({ confirmed: true, basis: null })],
      ...IDENTITY_FAILURE_CODES.filter((code) => code !== 'FACE_NOT_CONFIRMED').map(
        (code) => [`refused ${code}`, refused(code)] as [string, IdentityVerificationStatus],
      ),
    ];
    for (const [why, first] of screens) {
      mount(first);
      await screen.findByRole('heading', { level: 1 });
      expect(document.body.textContent ?? '', why).not.toMatch(selfieWords);
      cleanup();
    }
    mount(refused('FACE_NOT_CONFIRMED'));
    await screen.findByText(identityFailureCopy('FACE_NOT_CONFIRMED'));
    expect(document.body.textContent ?? '').toMatch(selfieWords);
  });
});

/**
 * [BUG-417] The portal's half of the stale-reason rule, rendered. The phone's three call sites are
 * held by `tsc` plus `clearIdentityProblem`'s own cases in the contracts suite and by nothing else,
 * because no test in this repository can render `app/(parent)/identity.tsx` — stated rather than
 * implied, since the whole defect was a rule that existed on one surface and not the other.
 */
describe('[BUG-417] a corrected field stops being scolded', () => {
  it('[repro] ticking the declaration clears ITS reason and leaves the others', async () => {
    mount(status());
    const submit = await waitForForm();
    await userEvent.click(submit);
    // All three unmet, all three said (L-059).
    await screen.findByText(IDENTITY_REQUIREMENT_COPY.declaration);
    expect(screen.getByText(IDENTITY_REQUIREMENT_COPY.document)).toBeTruthy();
    expect(screen.getByText(IDENTITY_REQUIREMENT_COPY.dateOfBirth)).toBeTruthy();

    await userEvent.click(screen.getByRole('checkbox', { name: IDENTITY_ATTESTATION_STATEMENT }));
    // THE ASSERTION. Before the fix this reason stayed on screen beside a ticked box, until the
    // parent pressed submit again — the portal telling them their correction did not count.
    await waitFor(() =>
      expect(screen.queryByText(IDENTITY_REQUIREMENT_COPY.declaration)).toBeNull(),
    );
    expect(screen.getByText(IDENTITY_REQUIREMENT_COPY.document)).toBeTruthy();
    expect(screen.getByText(IDENTITY_REQUIREMENT_COPY.dateOfBirth)).toBeTruthy();
  });

  it('[repro] typing a date of birth clears ITS reason and leaves the others', async () => {
    mount(status());
    const submit = await waitForForm();
    await userEvent.click(submit);
    await screen.findByText(IDENTITY_REQUIREMENT_COPY.dateOfBirth);

    // A FULL date, because this is `<input type="date">`: a date input fires no change event for a
    // partial value, in jsdom or in a browser, so a half-typed date keeps its reason until the date
    // is a date. Trying it with '1' is how that was learned — the case went red and the rule was
    // right. The reason is not re-judged as it is typed either; the submit judges every requirement
    // at once (L-059).
    await userEvent.type(
      screen.getByLabelText(IDENTITY_SCREEN_COPY.dateOfBirthLabel),
      '1990-04-12',
    );
    await waitFor(() =>
      expect(screen.queryByText(IDENTITY_REQUIREMENT_COPY.dateOfBirth)).toBeNull(),
    );
    expect(screen.getByText(IDENTITY_REQUIREMENT_COPY.document)).toBeTruthy();
    expect(screen.getByText(IDENTITY_REQUIREMENT_COPY.declaration)).toBeTruthy();
  });

  it('choosing a photo clears the photo reason and leaves the others', async () => {
    mount(status());
    const submit = await waitForForm();
    await userEvent.click(submit);
    await screen.findByText(IDENTITY_REQUIREMENT_COPY.document);

    await userEvent.upload(screen.getByLabelText(IDENTITY_SCREEN_COPY.documentLabel), pngFile());
    await waitFor(() => expect(screen.queryByText(IDENTITY_REQUIREMENT_COPY.document)).toBeNull());
    expect(screen.getByText(IDENTITY_REQUIREMENT_COPY.dateOfBirth)).toBeTruthy();
    expect(screen.getByText(IDENTITY_REQUIREMENT_COPY.declaration)).toBeTruthy();
  });
});
