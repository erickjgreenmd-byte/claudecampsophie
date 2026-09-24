import type { Sql, TransactionSql } from 'postgres';

/**
 * Database access with the caller's Postgres role (docs/Architecture.md §3). User requests run as
 * `authenticated` (parents) or `pl_child` (paired children) so RLS is a second, independent layer.
 * `asService` bypasses RLS: handlers using it must verify ownership of every referenced row.
 *
 * Production: the API connects as a login role that is a member of authenticated, pl_child and
 * service_role (see docs/Deployment_Runbook.md), through Hyperdrive or the Supabase pooler.
 */

export type Tx = TransactionSql;

export interface ParentPrincipal {
  readonly kind: 'parent';
  readonly userId: string;
  readonly sessionId: string;
  readonly aal: 'aal1' | 'aal2';
  /** Latest sign-in/re-authentication instant from the token's `amr` claims, if present. */
  readonly authenticatedAt?: Date;
}

export interface ChildPrincipal {
  readonly kind: 'child';
  readonly childId: string;
  readonly familyId: string;
  readonly sessionId: string;
}

export interface Db {
  asParent<T>(principal: ParentPrincipal, fn: (tx: Tx) => Promise<T>): Promise<T>;
  asChild<T>(principal: ChildPrincipal, fn: (tx: Tx) => Promise<T>): Promise<T>;
  asService<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export function createDb(sql: Sql): Db {
  async function run<T>(
    role: string,
    claims: Record<string, unknown>,
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    return (await sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
      // Role names are constants from this module, never user input.
      await tx.unsafe(`set local role ${role}`);
      return fn(tx);
    })) as T;
  }

  return {
    asParent(principal, fn) {
      return run(
        'authenticated',
        {
          sub: principal.userId,
          role: 'authenticated',
          session_id: principal.sessionId,
          aal: principal.aal,
        },
        fn,
      );
    },
    asChild(principal, fn) {
      return run(
        'pl_child',
        {
          role: 'pl_child',
          child_id: principal.childId,
          family_id: principal.familyId,
          child_session_id: principal.sessionId,
        },
        fn,
      );
    },
    asService(fn) {
      return run('service_role', { role: 'service_role' }, fn);
    },
  };
}
