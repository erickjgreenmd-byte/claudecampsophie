import { Hono } from 'hono';
import type { z } from 'zod';
import { ApiError, pgErrorCode } from './errors.ts';
import type { AppDeps, AppEnv } from './middleware/context.ts';
import { toBase64Url, randomBytes } from './security/crypto.ts';
import { healthRoutes } from './routes/health.ts';
import { adultRoutes } from './routes/adult.ts';
import { childAuthRoutes } from './routes/child-auth.ts';
import { familyRoutes } from './routes/family.ts';
import { rewardsRoutes } from './routes/rewards.ts';
import { homeworkRoutes } from './routes/homework.ts';
import { guardiansRoutes } from './routes/guardians.ts';
import { privacyRoutes } from './routes/privacy.ts';
import { learningRoutes } from './routes/learning.ts';
import { promotionsRoutes } from './routes/promotions.ts';
import { adminPromotionsRoutes } from './routes/admin-promotions.ts';
import { webhooksRoutes } from './routes/webhooks.ts';
import { monetizationRoutes } from './routes/monetization.ts';
import { adminMonetizationRoutes } from './routes/admin-monetization.ts';

/** Max JSON body accepted by any route (uploads use signed storage URLs, never the API body). */
export const MAX_JSON_BYTES = 64 * 1024;

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    const started = Date.now();
    c.set('deps', deps);
    c.set('requestId', toBase64Url(randomBytes(9)));
    const origin = c.req.header('origin');
    const allowed = origin !== undefined && deps.config.corsOrigins.includes(origin);
    if (c.req.method === 'OPTIONS') {
      if (!allowed) return c.body(null, 403);
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE');
      c.header('Access-Control-Allow-Headers', 'authorization,content-type,idempotency-key');
      c.header('Access-Control-Max-Age', '600');
      c.header('Vary', 'Origin');
      return c.body(null, 204);
    }
    const length = Number(c.req.header('content-length') ?? '0');
    if (length > MAX_JSON_BYTES) throw new ApiError('PAYLOAD_TOO_LARGE', 'Request is too large');
    await next();
    if (allowed) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Vary', 'Origin');
    }
    // Private data: never cache, never sniff, never frame.
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Request-Id', c.var.requestId);
    deps.log({
      level: 'info',
      event: 'request',
      requestId: c.var.requestId,
      status: c.res.status,
      durationMs: Date.now() - started,
    });
  });

  app.onError((error, c) => {
    const requestId = c.var.requestId ?? 'unknown';
    if (error instanceof ApiError) {
      if (error.retryAfterSeconds !== undefined)
        c.header('Retry-After', String(error.retryAfterSeconds));
      c.header('Cache-Control', 'no-store');
      return c.json(
        {
          error: {
            code: error.code,
            ...(error.rule === undefined ? {} : { rule: error.rule }),
            message: error.message,
            requestId,
          },
        },
        error.status as 400,
      );
    }
    // Expected database outcomes surfaced without leaking SQL or constraint internals.
    const pgCode = pgErrorCode(error);
    if (pgCode === '42501') {
      c.header('Cache-Control', 'no-store');
      return c.json({ error: { code: 'FORBIDDEN', message: 'Not allowed', requestId } }, 403);
    }
    if (pgCode === '23505') {
      c.header('Cache-Control', 'no-store');
      return c.json(
        { error: { code: 'CONFLICT', message: 'This was already done', requestId } },
        409,
      );
    }
    // Unexpected: log the class only (no message/stack that could contain data), answer generically.
    deps.log({ level: 'error', event: 'unhandled_error', requestId, code: error.name });
    c.header('Cache-Control', 'no-store');
    return c.json(
      {
        error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.', requestId },
      },
      500,
    );
  });

  app.notFound((c) =>
    c.json(
      {
        error: { code: 'NOT_FOUND', message: 'Not found', requestId: c.var.requestId ?? 'unknown' },
      },
      404,
    ),
  );

  app.route('/', healthRoutes());
  app.route('/v1/adult', adultRoutes());
  app.route('/v1/child', childAuthRoutes());
  app.route('/v1', familyRoutes());
  // Feature verticals. Each module owns its paths under the prefix shown.
  app.route('/v1', rewardsRoutes()); // /v1/rewards*, /v1/child/rewards*, /v1/points*
  app.route('/v1', homeworkRoutes()); // /v1/assignments*, /v1/child/assignments*, /v1/questions*
  app.route('/v1', guardiansRoutes()); // /v1/guardians*, /v1/invitations*, /v1/consent*
  app.route('/v1', privacyRoutes()); // /v1/deletion*, /v1/exports*, /v1/safety-reports*, /v1/child/reports*
  app.route('/v1', learningRoutes()); // /v1/subjects*, /v1/schedules*, /v1/test-dates*, /v1/child/practice*
  app.route('/v1', promotionsRoutes()); // /v1/schools*, /v1/family/school*, /v1/family/promotions*
  app.route('/v1/admin', adminPromotionsRoutes()); // /v1/admin/promo-*, campaigns, schools, payouts
  app.route('/v1', monetizationRoutes()); // /v1/resources*, /v1/placements*, /v1/outbound*
  app.route('/v1/admin', adminMonetizationRoutes()); // /v1/admin/monetization/*
  app.route('/webhooks', webhooksRoutes()); // /webhooks/revenuecat, /webhooks/stripe
  return app;
}

/** Parses and validates a JSON body with a strict contract schema. */
export async function readJson<S extends z.ZodType>(
  c: { req: { json: () => Promise<unknown> } },
  schema: S,
): Promise<z.infer<S>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ApiError('VALIDATION_FAILED', 'Request body must be JSON');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.') || '(body)').slice(0, 5);
    throw new ApiError('VALIDATION_FAILED', `Invalid request: ${fields.join(', ')}`);
  }
  return parsed.data;
}
