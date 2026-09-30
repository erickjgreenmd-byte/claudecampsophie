import { describe, expect, it } from 'vitest';
import {
  IDENTITY_ATTESTATION_REQUIRED_COPY,
  IDENTITY_ATTESTATION_STATEMENT,
  IDENTITY_BASIS_COPY,
  IDENTITY_FACE_CHECK_COPY,
  IDENTITY_FAILURE_CODES,
  IDENTITY_IMAGE_MAX_BYTES,
  IDENTITY_IMAGE_REJECTION_COPY,
  IDENTITY_REQUEST_FAILURE_COPY,
  IDENTITY_RULES,
  IDENTITY_REQUIREMENT_COPY,
  IDENTITY_SCREEN_COPY,
  identityFailureCopy,
  identityFailureIsOurs,
  identityRetryWorthwhile,
  IDENTITY_FAILURE_FALLBACK,
  type IdentityVerificationStatus,
} from '@pencillift/contracts';
import { ApiRequestError } from '@pencillift/contracts/client';
import {
  emptyIdentityForm,
  identityDocumentFromAsset,
  identityRequestProblem,
  identityView,
  submitIdentityForm,
  type IdentityFormState,
} from './identity-form.ts';

/**
 * The phone's ID screen, tested where it CAN be tested. `app/(parent)/identity.tsx` imports
 * react-native, which this project cannot render (vitest.config.ts), so every sentence the screen
 * prints and every decision it makes is decided here and the screen only renders what comes back.
 * That split is L-070's remedy: the portal's per-field edit rule was fixed three times and the
 * phone's never once, because the phone's rule lived inside a component no test could reach.
 *
 * The portal's equivalent of this module is the component `apps/web/src/pages/app/IdentityPage.tsx`
 * (its test is IdentityPage.test.tsx). Neither owns a sentence: both import them from
 * `@pencillift/contracts`, which is why a mutation of a contracts string reddens BOTH suites.
 *
 * Synthetic adults only; the "photo" is a 1x1 PNG.
 */

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AL+7AAAAABJRU5ErkJggg==';

function status(over: Partial<IdentityVerificationStatus> = {}): IdentityVerificationStatus {
  return {
    confirmed: false,
    basis: null,
    latest: null,
    attestationVersionRequired: '2026-09-v1',
    faceCheckAvailable: false,
    ...over,
  };
}

function refusedStatus(code: string | null): IdentityVerificationStatus {
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

function filled(over: Partial<IdentityFormState> = {}): IdentityFormState {
  return {
    ...emptyIdentityForm,
    dateOfBirth: '1990-04-12',
    document: { mimeType: 'image/png', base64: PNG_1X1, byteLength: 70 },
    declarationAffirmed: true,
    ...over,
  };
}

describe('the declaration is presented as a statement being made (0990)', () => {
  it('prints IDENTITY_ATTESTATION_STATEMENT in full beside the control that affirms it', () => {
    const view = identityView({ form: emptyIdentityForm, status: status(), busy: false });
    expect(view.body.kind).toBe('form');
    if (view.body.kind !== 'form') throw new Error('expected the form');
    expect(view.body.fields.declarationStatement).toBe(IDENTITY_ATTESTATION_STATEMENT);
  });

  /**
   * OVER EVERY STATE THE SCREEN HAS, not the two that were interesting. It covered the empty form
   * and one success, so a selfie prompt reintroduced on a REFUSAL — the state a parent who cannot
   * get past the check spends the most time in, and the state whose copy mentions a selfie in
   * `FACE_NOT_CONFIRMED` — would have shipped with this green.
   *
   * `FACE_NOT_CONFIRMED` is the exception and is named as one: it is the stronger standard's refusal
   * and its words are about a selfie by necessity. It cannot be reached by a deployment that cannot
   * compare faces, and this asserts it is the ONLY state whose text may say so.
   */
  it('never asks for a selfie in any state, and only the face refusal may mention one', () => {
    const selfieWords = /selfie|face photo|photo of yourself|front camera/i;
    const states: [string, ReturnType<typeof identityView>][] = [
      ['empty form', identityView({ form: emptyIdentityForm, status: status(), busy: false })],
      ['filled form', identityView({ form: filled(), status: status(), busy: false })],
      ['busy', identityView({ form: filled(), status: status(), busy: true })],
      [
        'declared',
        identityView({
          form: filled(),
          status: status({ confirmed: true, basis: 'declared' }),
          busy: false,
        }),
      ],
      [
        'unstated',
        identityView({
          form: filled(),
          status: status({ confirmed: true, basis: null }),
          busy: false,
        }),
      ],
      [
        'transport problem',
        identityView({
          form: filled(),
          status: status(),
          busy: false,
          transportProblem: IDENTITY_REQUEST_FAILURE_COPY.offline,
        }),
      ],
      ...IDENTITY_FAILURE_CODES.filter((code) => code !== 'FACE_NOT_CONFIRMED').map(
        (code) =>
          [
            `refused ${code}`,
            identityView({ form: filled(), status: refusedStatus(code), busy: false }),
          ] as [string, ReturnType<typeof identityView>],
      ),
    ];
    for (const [why, view] of states) {
      expect(JSON.stringify(view), why).not.toMatch(selfieWords);
    }
    // And the one exception really is reachable and really does say so, so the filter above is a
    // stated exemption rather than a hole the property quietly steps around.
    expect(
      JSON.stringify(
        identityView({ form: filled(), status: refusedStatus('FACE_NOT_CONFIRMED'), busy: false }),
      ),
    ).toMatch(selfieWords);
  });

  /**
   * THE FALL-THROUGH, RENDERED. `identityOutcome` maps `basis: null` on a confirmed adult to
   * 'unstated', and the contracts suite pins that mapping — but a screen can still print the wrong
   * key, and mutating the fall-through to 'verified' reddened NOTHING on either surface until this
   * case and the portal's twin existed. A family established before either table recorded a basis
   * would then have read "a face check confirmed it is yours" about a check that never ran.
   */
  it('a confirmed adult with no stated basis is never told a face check ran', () => {
    const view = identityView({
      form: filled(),
      status: status({ confirmed: true, basis: null }),
      busy: false,
    });
    expect(view.body.kind).toBe('established');
    if (view.body.kind !== 'established') throw new Error('expected the success state');
    expect(view.body.headline).toBe(IDENTITY_BASIS_COPY.unstated.headline);
    const printed = `${view.body.headline} ${view.body.detail}`;
    expect(printed).not.toMatch(/face check/i);
    expect(printed).not.toMatch(/\bverif(y|ied|ication)\b/i);
  });

  /**
   * THE MISSING-PHOTO LINE, which no case read. It is the first thing a parent who taps submit too
   * early sees, and `IDENTITY_REQUIREMENT_COPY.document` could have been swapped for any other
   * field's sentence — or for the date-of-birth one — with both suites green.
   */
  it('a submit with no photo names the PHOTO, beside the photo control', () => {
    const view = identityView({
      form: {
        ...filled(),
        document: null,
        problems: [{ field: 'document', message: IDENTITY_REQUIREMENT_COPY.document }],
      },
      status: status(),
      busy: false,
    });
    expect(view.body.kind).toBe('form');
    if (view.body.kind !== 'form') throw new Error('expected the form');
    expect(view.body.fields.documentProblem).toBe(IDENTITY_REQUIREMENT_COPY.document);
    // The reason sits beside the control it belongs to and nowhere else (L-059).
    expect(view.body.fields.dateOfBirthProblem).toBeNull();
    expect(view.body.fields.declarationProblem).toBeNull();
    // And the sentence says what is missing, not merely that something is.
    expect(IDENTITY_REQUIREMENT_COPY.document).toMatch(/photo|ID/i);
  });
});

describe('a submit reports EVERY unmet requirement in one pass (L-059)', () => {
  it('a parent missing the date AND the declaration sees both reasons, and no request is sent', async () => {
    let sent = 0;
    const result = await submitIdentityForm(
      filled({ dateOfBirth: '', declarationAffirmed: false }),
      () => {
        sent += 1;
        return Promise.reject(new Error('the form must not be sent'));
      },
    );
    expect(sent).toBe(0);
    expect(result.kind).toBe('unmet');
    if (result.kind !== 'unmet') throw new Error('expected unmet');
    const messages = result.problems.map((p) => p.message);
    expect(messages).toContain(IDENTITY_REQUIREMENT_COPY.dateOfBirth);
    expect(messages).toContain(IDENTITY_ATTESTATION_REQUIRED_COPY);
    expect(messages).toHaveLength(2);
  });

  it('the submit control is never disabled: it is what reports the reasons', () => {
    const view = identityView({ form: emptyIdentityForm, status: status(), busy: false });
    if (view.body.kind !== 'form') throw new Error('expected the form');
    expect(view.body.submitDisabled).toBe(false);
  });

  it('every reported problem is rendered beside its own field', () => {
    const view = identityView({
      form: {
        ...emptyIdentityForm,
        problems: [
          { field: 'document', message: IDENTITY_REQUIREMENT_COPY.document },
          { field: 'dateOfBirth', message: IDENTITY_REQUIREMENT_COPY.dateOfBirth },
          { field: 'declaration', message: IDENTITY_ATTESTATION_REQUIRED_COPY },
        ],
      },
      status: status(),
      busy: false,
    });
    if (view.body.kind !== 'form') throw new Error('expected the form');
    expect(view.body.fields.documentProblem).toBe(IDENTITY_REQUIREMENT_COPY.document);
    expect(view.body.fields.dateOfBirthProblem).toBe(IDENTITY_REQUIREMENT_COPY.dateOfBirth);
    expect(view.body.fields.declarationProblem).toBe(IDENTITY_ATTESTATION_REQUIRED_COPY);
  });
});

describe('the image goes into the request body and nowhere else', () => {
  it('sends base64 with no data URL prefix, and the mime type beside it', async () => {
    const bodies: unknown[] = [];
    await submitIdentityForm(filled(), (body) => {
      bodies.push(body);
      return Promise.resolve(status({ confirmed: true, basis: 'declared' }));
    });
    expect(bodies).toEqual([
      {
        statedDateOfBirth: '1990-04-12',
        document: { mimeType: 'image/png', base64: PNG_1X1 },
        holderAttestation: true,
      },
    ]);
  });

  it('refuses a photo over IDENTITY_IMAGE_MAX_BYTES before it is sent, naming the action', async () => {
    let sent = 0;
    const result = await submitIdentityForm(
      filled({
        document: {
          mimeType: 'image/png',
          base64: PNG_1X1,
          byteLength: IDENTITY_IMAGE_MAX_BYTES + 1,
        },
      }),
      () => {
        sent += 1;
        return Promise.reject(new Error('must not be sent'));
      },
    );
    expect(sent).toBe(0);
    if (result.kind !== 'unmet') throw new Error('expected unmet');
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.field).toBe('document');
    expect(result.problems[0]?.message).toMatch(/take the photo again/i);
  });

  it('refuses a mime type the check cannot read, before it is sent', async () => {
    let sent = 0;
    const result = await submitIdentityForm(
      filled({
        document: { mimeType: 'image/heic', base64: PNG_1X1, byteLength: 70 },
      }),
      () => {
        sent += 1;
        return Promise.reject(new Error('must not be sent'));
      },
    );
    expect(sent).toBe(0);
    if (result.kind !== 'unmet') throw new Error('expected unmet');
    expect(result.problems[0]?.field).toBe('document');
    expect(result.problems[0]?.message).toMatch(/JPEG or PNG/);
  });
});

describe('a refusal is worded by identityFailureCopy, and the retry follows identityFailureIsOurs', () => {
  it('DOB_MISMATCH: the contract sentence, with the form still there to fix', () => {
    const view = identityView({
      form: filled(),
      status: refusedStatus('DOB_MISMATCH'),
      busy: false,
    });
    if (view.body.kind !== 'form') throw new Error('the parent can fix this, so the form stays');
    expect(view.body.refusal).toBe(identityFailureCopy('DOB_MISMATCH'));
  });

  it('ATTESTATION_REQUIRED keeps the form, because the parent can always fix it', () => {
    const view = identityView({
      form: filled(),
      status: refusedStatus('ATTESTATION_REQUIRED'),
      busy: false,
    });
    expect(view.body.kind).toBe('form');
    if (view.body.kind !== 'form') throw new Error('expected the form');
    expect(view.body.refusal).toBe(identityFailureCopy('ATTESTATION_REQUIRED'));
  });

  it('PROVIDER_UNAVAILABLE is ours: no retry is offered, and support is', () => {
    const view = identityView({
      form: filled(),
      status: refusedStatus('PROVIDER_UNAVAILABLE'),
      busy: false,
    });
    expect(view.body.kind).toBe('blocked');
    if (view.body.kind !== 'blocked') throw new Error('expected blocked');
    expect(view.body.message).toBe(identityFailureCopy('PROVIDER_UNAVAILABLE'));
    expect(view.body.message).toMatch(/on us, not you/i);
  });

  it('a row that does not say why reaches the fallback, not the nearest guess (L-057)', () => {
    const view = identityView({ form: filled(), status: refusedStatus(null), busy: false });
    if (view.body.kind !== 'blocked')
      throw new Error('a reason we cannot name is not theirs to fix');
    expect(view.body.message).toBe(IDENTITY_FAILURE_FALLBACK);
  });

  /**
   * HOW FAR THIS CASE REACHES, stated rather than implied. A code outside
   * `IDENTITY_FAILURE_CODES` cannot arrive over the wire: `identityVerificationStatusSchema` is
   * `z.enum(...)` there, so the client rejects the whole response and the parent gets the
   * request-failure line instead (the portal's suite asserts exactly that, and finding it is what
   * corrected this file's first version of the case above).
   *
   * What this pins is the DECISION's fall-through, which is the L-057 property and which outlives
   * the enum: the day a provider adds a code and the enum is widened to carry it, `identityOutcome`
   * already lands it on the honest branch rather than on the nearest enumerated guess.
   */
  it('a code the decision has never heard of lands on the honest branch, not a guess', () => {
    const view = identityView({
      form: filled(),
      status: refusedStatus('A_CODE_THIS_BUILD_HAS_NEVER_HEARD_OF'),
      busy: false,
    });
    if (view.body.kind !== 'blocked') throw new Error('an unknown code cannot be theirs to fix');
    expect(view.body.message).toBe(IDENTITY_FAILURE_FALLBACK);
  });
});

describe('the success state names the BASIS honestly', () => {
  it('a declared basis is never called verified', () => {
    const view = identityView({
      form: filled(),
      status: status({ confirmed: true, basis: 'declared' }),
      busy: false,
    });
    if (view.body.kind !== 'established') throw new Error('expected established');
    expect(view.body.headline).toBe(IDENTITY_BASIS_COPY.declared.headline);
    expect(`${view.body.headline} ${view.body.detail}`).not.toMatch(/\bverified\b/i);
  });

  it('a verified basis says so', () => {
    const view = identityView({
      form: filled(),
      status: status({ confirmed: true, basis: 'verified', faceCheckAvailable: true }),
      busy: false,
    });
    if (view.body.kind !== 'established') throw new Error('expected established');
    expect(view.body.headline).toBe(IDENTITY_BASIS_COPY.verified.headline);
  });

  it('no entry of the basis table can print an unconditional “verified” (L-068)', () => {
    for (const [key, entry] of Object.entries(IDENTITY_BASIS_COPY)) {
      expect(entry.headline.length, key).toBeGreaterThan(0);
      expect(entry.detail.length, key).toBeGreaterThan(0);
      if (key !== 'verified') {
        expect(`${entry.headline} ${entry.detail}`, key).not.toMatch(/\bverified\b/i);
      }
    }
  });

  it('the face-check note is the same sentence in the form and in the success state (L-068)', () => {
    const before = identityView({ form: emptyIdentityForm, status: status(), busy: false });
    const after = identityView({
      form: filled(),
      status: status({ confirmed: true, basis: 'declared' }),
      busy: false,
    });
    expect(before.faceCheckNote).toBe(IDENTITY_FACE_CHECK_COPY.unavailable);
    expect(after.faceCheckNote).toBe(before.faceCheckNote);
  });
});

describe('a request that could not be made is worded by the contract, and is retryable', () => {
  it('offline: the contract sentence, and the form is still there', async () => {
    const result = await submitIdentityForm(filled(), () =>
      Promise.reject(new ApiRequestError('NETWORK', 'offline', 0)),
    );
    if (result.kind !== 'failed') throw new Error('expected a failed request');
    expect(result.message).toBe(IDENTITY_REQUEST_FAILURE_COPY.offline);
    const view = identityView({
      form: filled(),
      status: status(),
      busy: false,
      transportProblem: result.message,
    });
    if (view.body.kind !== 'form') throw new Error('a failed request leaves the form in place');
    expect(view.body.transportProblem).toBe(IDENTITY_REQUEST_FAILURE_COPY.offline);
  });

  it('an already-recorded check is not reported as a failure of this photo', async () => {
    const result = await submitIdentityForm(filled(), () =>
      Promise.reject(
        new ApiRequestError('BUSINESS_RULE', 'already', 422, IDENTITY_RULES.alreadyConfirmed),
      ),
    );
    if (result.kind !== 'failed') throw new Error('expected a failed request');
    expect(result.message).toBe(IDENTITY_REQUEST_FAILURE_COPY.alreadyConfirmed);
  });

  it('a thrown value that is not an ApiRequestError never becomes copy', () => {
    expect(identityRequestProblem(new Error('TypeError: x is not a function'))).toBe(
      IDENTITY_REQUEST_FAILURE_COPY.unknown,
    );
    expect(identityRequestProblem('boom')).toBe(IDENTITY_REQUEST_FAILURE_COPY.unknown);
  });
});

/**
 * PROPERTIES OF THE SENTENCES, not their text.
 *
 * WHY THESE EXIST. The first version of this file asserted each line by importing the constant and
 * comparing it with itself, and a mutation check proved the assertions worthless: rewriting
 * `IDENTITY_REQUIREMENT_COPY.document` to 'A photo of your ID is needed.' — a line that names no
 * action — reddened NOTHING on either surface, because the expected value moved with the actual.
 * Equality with an imported constant pins WHERE a sentence comes from; only a property pins what it
 * has to say. Both matter, so both are here, and the portal's suite carries the same properties.
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

  it('the declaration still says all four things it exists to say', () => {
    const view = identityView({ form: emptyIdentityForm, status: status(), busy: false });
    if (view.body.kind !== 'form') throw new Error('expected the form');
    const printed = view.body.fields.declarationStatement;
    expect(printed).toMatch(/person shown on this document/i);
    expect(printed).toMatch(/18 years old/);
    expect(printed).toMatch(/parent or legal guardian/i);
    expect(printed).toMatch(/legal declaration/i);
  });

  /**
   * Over the whole SET of codes rather than the ones that happen to be interesting (L-057): a code
   * added later is carried by this the day the enum grows, instead of being a case nobody wrote.
   *
   * WHAT DECIDES IT IS `identityRetryWorthwhile`, NOT `identityFailureIsOurs`. This case asserted
   * the second and went red when the contract split the two questions apart — correctly, because it
   * had encoded the defect: whose fault a refusal is and whether trying again can help are not the
   * same question, and `PROVIDER_ERROR` is ours AND retryable. Under the old rule its copy told the
   * parent "Please try again" on a screen with no control to do it.
   */
  it('every code keeps the form exactly where trying again could help', () => {
    for (const code of IDENTITY_FAILURE_CODES) {
      const view = identityView({ form: filled(), status: refusedStatus(code), busy: false });
      expect(view.body.kind, code).toBe(identityRetryWorthwhile(code) ? 'form' : 'blocked');
      const message = view.body.kind === 'blocked' ? view.body.message : null;
      const refusal = view.body.kind === 'form' ? view.body.refusal : null;
      expect(message ?? refusal, code).toBe(identityFailureCopy(code));
      // The words and the control agree, which is the invariant the split exists to keep.
      if (/try again/i.test(identityFailureCopy(code))) {
        expect(view.body.kind, `${code} says "try again"`).toBe('form');
      }
      // And a refusal that is OURS says so wherever it lands, blocked or not: the tone is the other
      // question the one predicate used to answer (L-076).
      if (identityFailureIsOurs(code)) {
        expect(identityFailureCopy(code), code).toMatch(/on us|on our side|support/i);
      }
    }
  });
});

/**
 * The phone's half of the same line. `identity.tsx` renders `IDENTITY_SCREEN_COPY.loadingLabel`
 * while the GET is in flight, and this pins what that constant has to say.
 *
 * ITS LIMIT, stated because the claim would otherwise be bigger than the evidence: no test in this
 * repository can render `identity.tsx`, so what holds the screen to this constant is `tsc` plus the
 * rule that the screen prints no sentence of its own. A real shared export is what makes the rule
 * checkable at all — a source pin would catch a reworded literal and miss a new one.
 */
describe('the “still loading” line', () => {
  it('says what is being checked, and is the only definition of it', () => {
    expect(IDENTITY_SCREEN_COPY.loadingLabel).toMatch(/record/i);
    expect(IDENTITY_SCREEN_COPY.loadingLabel.length).toBeGreaterThan(0);
  });
});

/**
 * [BUG-416] THE PICKED PHOTO'S GATE, which had no test at all — and a function with no test is where
 * a divergence lives longest. `identityDocumentFromAsset` hand-rolled two of the three checks the
 * portal's `identityDocumentFromFile` gets from `identityImageRejection`: a missing mime type was
 * refused, a PRESENT wrong one was not, and `IDENTITY_IMAGE_MAX_BYTES` was never consulted.
 *
 * Nothing could actually be SENT, because `prepareIdentitySubmission` asks the same question again
 * with the bytes in hand. What the parent got instead was the worse screen: the phone accepted a
 * HEIC, called it chosen, and waited until they had typed their date of birth and read the
 * declaration before saying "we can read JPEG and PNG" — while the portal says it on pick.
 */
describe('[BUG-416] the picked photo is refused where the portal refuses it', () => {
  const JPEG = 'aGVsbG8=';

  it('[repro] a HEIC of a valid size is refused at PICK time, by type', () => {
    const result = identityDocumentFromAsset({ mimeType: 'image/heic', base64: JPEG });
    expect('rejection' in result).toBe(true);
    if (!('rejection' in result)) throw new Error('unreachable');
    expect(result.rejection).toBe(IDENTITY_IMAGE_REJECTION_COPY.mimeType);
  });

  it('[repro] a photo over the cap is refused at PICK time, by size', () => {
    // Base64 expands by 4/3, so this decodes to just over the cap.
    const oversized = 'A'.repeat(Math.ceil((IDENTITY_IMAGE_MAX_BYTES + 1024) * 4) / 3);
    const result = identityDocumentFromAsset({ mimeType: 'image/jpeg', base64: oversized });
    expect('rejection' in result).toBe(true);
    if (!('rejection' in result)) throw new Error('unreachable');
    expect(result.rejection).toBe(IDENTITY_IMAGE_REJECTION_COPY.tooLarge);
  });

  it('an empty photo is refused, and a missing type is refused as a TYPE not as empty', () => {
    const empty = identityDocumentFromAsset({ mimeType: 'image/jpeg', base64: '' });
    expect('rejection' in empty && empty.rejection).toBe(IDENTITY_IMAGE_REJECTION_COPY.empty);
    // The shared gate asks the type first on purpose: a HEIC of any size is the wrong thing to
    // shrink, and this used to answer "came through empty" for a photo whose type was the problem.
    const typeless = identityDocumentFromAsset({ mimeType: null, base64: '' });
    expect('rejection' in typeless && typeless.rejection).toBe(
      IDENTITY_IMAGE_REJECTION_COPY.mimeType,
    );
  });

  it('a JPEG within the cap becomes a document whose size is measured from the BASE64', () => {
    const result = identityDocumentFromAsset({ mimeType: 'image/jpeg', base64: JPEG });
    expect('document' in result).toBe(true);
    if (!('document' in result)) throw new Error('unreachable');
    expect(result.document.mimeType).toBe('image/jpeg');
    expect(result.document.base64).toBe(JPEG);
    // 'aGVsbG8=' is 'hello': 5 bytes. Not the picker's `fileSize`, which reports the file it
    // started from rather than what the request will carry.
    expect(result.document.byteLength).toBe(5);
  });

  it('a PNG is accepted too, so the gate is the shared list and not one hard-coded type', () => {
    const result = identityDocumentFromAsset({ mimeType: 'image/png', base64: JPEG });
    expect('document' in result).toBe(true);
  });
});
