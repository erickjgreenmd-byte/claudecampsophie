/**
 * Data-practices notice logic for the phone (spec P4, P15; AC_ACCESS_03). Pure: no react-native
 * imports, so the decisions below are tested rather than eyeballed.
 *
 * The states come from `GET /v1/data-practices`, which the API derives from the gates themselves.
 * Before the answer arrives, and whenever it cannot be fetched, the view state is `unknown` and the
 * sentence shown takes the WIDER case — a child's work may be read by OpenAI. That is the opposite
 * direction from `checkChildDataGate`, which fails closed by refusing to SEND: here the harmful
 * error is the reassuring one, so "fail closed" means disclose (L-082).
 *
 * WHAT THE PHONE SHOWS IS A SUBSET OF WHAT THE PORTAL SHOWS, deliberately. A permanent three-line
 * legal strip on every parent screen would cost more vertical space than a phone has, so the strip
 * here carries the child-work sentence and a way through to the privacy screen, and the adult-ID
 * sentence appears on the privacy screen. Both sentences come from the same constants in
 * `@pencillift/contracts`, so the two surfaces cannot come to say different things — only different
 * amounts (L-070, L-078).
 */
import {
  DATA_PRACTICES_COPY,
  DATA_PRACTICE_UNKNOWN,
  dataPracticeAdultIdText,
  dataPracticeChildWorkText,
  dataPracticesResponseSchema,
  type DataPracticeAdultIdView,
  type DataPracticeChildWorkView,
} from '@pencillift/contracts';
import type { ApiClient } from '@pencillift/contracts/client';

export interface DataPracticesState {
  readonly childWork: DataPracticeChildWorkView;
  readonly adultId: DataPracticeAdultIdView;
}

/** What a parent sees before anything has been fetched: the wider case, never the comfortable one. */
export const UNKNOWN_DATA_PRACTICES: DataPracticesState = {
  childWork: DATA_PRACTICE_UNKNOWN,
  adultId: DATA_PRACTICE_UNKNOWN,
};

/**
 * The published states, or the unknown state on ANY failure — a network error, a timeout, a body
 * the schema refuses. A notice is not worth an error screen and must never be worth a guess, so the
 * only two outcomes are "the server's answer" and "the wider case".
 */
export async function loadDataPractices(api: ApiClient): Promise<DataPracticesState> {
  try {
    // Parsed HERE as well as by the client. `createApiClient` validates against the schema it is
    // handed, so this is belt and braces — and the belt is worth it: without it the guarantee above
    // belongs to whichever client is passed in, not to this function, and a body that slipped
    // through would set `adultId` to a value that READS AS REASSURING. The test that found this was
    // itself using a client that did not validate, which is exactly how it would happen for real
    // (L-080: a type is erased at runtime; assert at the boundary).
    const published = dataPracticesResponseSchema.parse(
      await api.get('/v1/data-practices', dataPracticesResponseSchema),
    );
    return { childWork: published.childWork, adultId: published.adultId };
  } catch {
    return UNKNOWN_DATA_PRACTICES;
  }
}

/** The strip on every parent screen: one sentence and the way to the full policy. */
export function dataPracticesStrip(state: DataPracticesState): {
  readonly heading: string;
  readonly sentence: string;
  readonly linkLabel: string;
} {
  return {
    heading: DATA_PRACTICES_COPY.heading,
    sentence: dataPracticeChildWorkText(state.childWork),
    linkLabel: DATA_PRACTICES_COPY.linkLabel,
  };
}

/** The privacy screen's fuller version: both sentences, the adult-ID one included when known. */
export function dataPracticesDetail(state: DataPracticesState): readonly string[] {
  const adultId = dataPracticeAdultIdText(state.adultId);
  return adultId === null
    ? [dataPracticeChildWorkText(state.childWork)]
    : [dataPracticeChildWorkText(state.childWork), adultId];
}
