import type { RandomSource } from '@pencillift/domain';
import type { ApiConfig } from '../config.ts';
import type { ChildPrincipal, Db, ParentPrincipal } from '../db.ts';
import type { ParentTokenVerifier } from '../auth/parent.ts';
import type { RateLimiter } from './rate-limit.ts';
import type { Providers } from '../providers/index.ts';

/** Everything a request handler may depend on; injected so tests use real Postgres + fixed clocks. */
export interface AppDeps {
  readonly config: ApiConfig;
  readonly db: Db;
  readonly clock: () => Date;
  readonly random: RandomSource;
  readonly verifyParentToken: ParentTokenVerifier;
  readonly rateLimiter: RateLimiter;
  readonly providers: Providers;
  readonly log: (event: LogEvent) => void;
}

/** Payload-free operational log event (spec P4): ids, status and latency only. */
export interface LogEvent {
  readonly level: 'info' | 'warn' | 'error';
  readonly event: string;
  readonly requestId?: string;
  readonly status?: number;
  readonly code?: string;
  readonly durationMs?: number;
}

export interface AppEnv {
  Variables: {
    deps: AppDeps;
    requestId: string;
    parent: ParentPrincipal;
    child: ChildPrincipal;
  };
}
