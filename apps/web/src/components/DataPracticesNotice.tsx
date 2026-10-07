import {
  DATA_PRACTICES_COPY,
  DATA_PRACTICE_UNKNOWN,
  dataPracticeAdultIdText,
  dataPracticeChildWorkText,
  dataPracticesResponseSchema,
  type DataPracticeAdultIdView,
  type DataPracticeChildWorkView,
} from '@pencillift/contracts';
import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router';
import { useSession } from '../lib/session.tsx';

/**
 * The data-practices notice, on every page of the portal, the owner console and the public site
 * (spec P4, P15; AC_ACCESS_03).
 *
 * WHY IT STARTS AS `unknown` AND WHY THAT STATE DISCLOSES. The states come from the server, which
 * derives them from the gates themselves, so the first paint has no answer yet and a failed fetch
 * never gets one. The sentence shown in the meantime takes the WIDER case — a child's work may be
 * read by OpenAI — because the harmful error here is the reassuring one. That is the opposite
 * direction from `checkChildDataGate`, which fails closed by refusing to SEND: the same words,
 * pointing the other way, and a mistake worth making explicitly (L-082).
 *
 * The words themselves are in `@pencillift/contracts` so the phone prints the same sentences. Only
 * the way out to the policy differs, which is why the link lives here and not in the shared copy
 * (L-078).
 */
export interface DataPracticesView {
  readonly childWork: DataPracticeChildWorkView;
  readonly adultId: DataPracticeAdultIdView;
}

/**
 * The published states, or `unknown` until they arrive. Exported because the public privacy page
 * needs the SAME answer as the strip: that page asserted "OpenAI, under zero data retention" as a
 * flat fact, with nothing connecting it to the gate that decides, and a page and a strip disagreeing
 * about this on the same screen would be worse than either alone (BUG-430).
 */
export function useDataPractices(): DataPracticesView {
  const { api } = useSession();
  const [childWork, setChildWork] = useState<DataPracticeChildWorkView>(DATA_PRACTICE_UNKNOWN);
  const [adultId, setAdultId] = useState<DataPracticeAdultIdView>(DATA_PRACTICE_UNKNOWN);

  useEffect(() => {
    const controller = new AbortController();
    api
      .get('/v1/data-practices', dataPracticesResponseSchema, { signal: controller.signal })
      // Parsed here as well as by the client, for the reason the phone's loader states: without it
      // the guarantee belongs to whichever client is injected, and a body that slipped through
      // would set a state that READS AS REASSURING (L-080).
      .then((body) => dataPracticesResponseSchema.parse(body))
      .then((published) => {
        setChildWork(published.childWork);
        setAdultId(published.adultId);
      })
      // Deliberately silent and deliberately sticky: a notice that cannot confirm the setting keeps
      // showing the wider case. Nothing is logged, because this runs on every page view and a
      // failed fetch of a public endpoint is not an incident.
      .catch(() => undefined);
    return () => controller.abort();
  }, [api]);

  return { childWork, adultId };
}

export function DataPracticesNotice() {
  const headingId = useId();
  const { childWork, adultId } = useDataPractices();
  const adultIdText = dataPracticeAdultIdText(adultId);
  return (
    <section className="data-practices" aria-labelledby={headingId}>
      <h2 id={headingId}>{DATA_PRACTICES_COPY.heading}</h2>
      <p>{dataPracticeChildWorkText(childWork)}</p>
      {adultIdText === null ? null : <p>{adultIdText}</p>}
      <p>
        <Link to="/privacy">{DATA_PRACTICES_COPY.linkLabel}</Link>
      </p>
    </section>
  );
}
