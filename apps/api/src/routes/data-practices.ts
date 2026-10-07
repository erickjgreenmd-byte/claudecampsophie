import {
  dataPracticesResponseSchema,
  type DataPracticeAdultIdState,
  type DataPracticeChildWorkState,
  type DataPracticesResponse,
} from '@pencillift/contracts';
import { checkChildDataGate, validateZdrEvidence } from '@pencillift/ai';
import { Hono } from 'hono';
import type { ApiConfig } from '../config.ts';
import type { AppEnv } from '../middleware/context.ts';

/**
 * `GET /v1/data-practices` — what this deployment actually sends to a third party, for the notice
 * on every adult-facing page (spec P4, P15; AC_ACCESS_03).
 *
 * PUBLIC AND UNAUTHENTICATED, because the notice is on the landing, pricing and privacy pages where
 * nobody is signed in. What it reveals is the disclosure itself, which is the point. What it must
 * never reveal is the ZDR approval REFERENCE: that is a contract or ticket identifier belonging to
 * the owner's OpenAI organization, it is not a parent's business, and a public endpoint leaking it
 * would turn a privacy notice into an information disclosure. Hence two enums and nothing else;
 * `dataPracticesResponseSchema` is strict, so a field added here fails the contract test rather
 * than shipping.
 *
 * DERIVED FROM THE GATES, NOT FROM A FLAG. `childWork` asks `checkChildDataGate` the same question
 * a real request asks and reads its ANSWER, so the notice cannot claim zero data retention unless
 * the gate would itself have produced a reference for a child's request. The alternative — a second
 * boolean the owner sets — is how the public privacy page came to assert "OpenAI, under zero data
 * retention" while the server was refusing every child request for want of that approval (BUG-430).
 */
export function dataPracticesFor(config: ApiConfig, now: Date): DataPracticesResponse {
  // ageBand null is the conservative read: `mayIncludeUnder13(null)` is true, so this asks the
  // question for the youngest child the product accepts rather than for an average one.
  const gate = checkChildDataGate({
    containsChildPersonalData: true,
    ageBand: null,
    zdrEvidence: config.zdrEvidence,
    environment: config.environment,
    providerIsMock: config.providers.ai !== 'openai',
    now,
  });
  // `zdrReference` is non-null only when real child data would travel under approved evidence. A
  // refused gate and a labeled mock both mean nothing leaves, and both read `not_sent` here.
  const childWork: DataPracticeChildWorkState =
    gate.ok && gate.value.zdrReference !== null ? 'openai_under_zdr' : 'not_sent';
  // The adult ID check is NOT covered by the child-data gate (an adult's licence is not child
  // personal data), so it carries its own evidence check — the same one its adapter applies before
  // sending a document, in providers/identity-openai.ts.
  const adultId: DataPracticeAdultIdState =
    config.providers.identity === 'vendor'
      ? 'identity_vendor'
      : config.providers.identity === 'openai_document' &&
          validateZdrEvidence(config.zdrEvidence, now).ok
        ? 'openai_under_zdr'
        : 'not_sent';
  return { childWork, adultId };
}

export function dataPracticesRoutes(): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.get('/v1/data-practices', (c) => {
    const { config, clock } = c.var.deps;
    const body = dataPracticesResponseSchema.parse(dataPracticesFor(config, clock()));
    // NO per-route cache header. app.ts sets `Cache-Control: no-store` on every response, and this
    // route is not worth an exception: the body is two short enums computed from configuration
    // already in memory, so the saving would be nothing and the cost would be one route that opts
    // out of a security default. A cached notice is also a notice that can go on saying "not sent"
    // for five minutes after that stopped being true.
    return c.json(body);
  });
  return r;
}
