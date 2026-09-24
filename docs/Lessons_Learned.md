# PencilLift verified project lessons (spec E5.5, AC_ECC_11)

Accepted lessons only; each cites evidence. Project-scoped; never overrides requirements or permissions.

| Lesson ID | Trigger / scope | Proven root cause | Correction / prevention | Evidence | Revalidate when | Status |
|---|---|---|---|---|---|---|
| L-001 | Creating Postgres roles in migrations/test setup | Roles are cluster-wide; `if not exists` check-then-create races between concurrent sessions | Wrap `create role` in a DO block catching `duplicate_object` and `unique_violation` | BUG-001 | Postgres major upgrade | accepted |
| L-002 | Any new function in `app`/`public` | Postgres grants EXECUTE to PUBLIC by default, and `ALTER DEFAULT PRIVILEGES IN SCHEMA … REVOKE` cannot remove a global default (per-schema defaults only add). The first version of this lesson wrongly trusted the schema-level revoke | Global `ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` in 0001 + explicit revoke/grant per SECURITY DEFINER function; `schema_invariants.test.ts` fails if anon can execute any | BUG-002 | New schema, or migrations run by a different role | accepted (corrected) |
| L-003 | Any child (`pl_child`) query | Child access uses column-level grants; `select *` is denied (fail closed) rather than filtering columns | API child queries and DTO builders must name the allowlisted columns explicitly; tests assert both the allowlist and that `*`/forbidden columns are denied | `supabase/tests/learning.test.ts` (2 initial failures from `select *` in tests) | Child-readable columns change | accepted |
| L-004 | Any pre-commit check in shell | Piping a check into `grep`/`tail` discards its exit status, and a commit on its own line runs regardless of an earlier failed check (BUG-003, BUG-004, BUG-024) | Gate commits with `scripts/verify.sh`; the versioned `scripts/git-hooks/pre-commit` hook (enabled via `core.hooksPath`) blocks lint/format/secret failures on staged files independent of the command line | BUG-003, BUG-004, BUG-024 | Shell/CI changes | accepted (strengthened) |
| L-005 | Upserts with `ON CONFLICT … DO UPDATE … WHERE` guards | A guard that fails turns the write into a silent no-op; if later logic trusts in-memory state, data is silently wrong (BUG-006) | Add `RETURNING` and assert the row count; keys for provider objects must be globally unique (include the subscriber identity) | BUG-006 | Any new provider/external-id upsert | accepted |
| L-006 | Writing JSON to Postgres with postgres.js | A JS string bound to a `jsonb`-typed parameter is JSON-encoded again, producing a string scalar (BUG-008) | Bind `${JSON.stringify(x)}::text::jsonb` (or `sql.json(x)`); every jsonb column carries a `jsonb_typeof in ('object','array')` check and a schema invariant enforces it for new columns | BUG-008 | postgres.js major upgrade, new driver | accepted |
| L-007 | Any client code that needs a child or parent token | Rotating refresh tokens tolerate exactly one refresher per device; a second, independent refresher eventually replays a token and the server revokes the session (BUG-012) | Obtain tokens only from `apps/mobile/src/lib/app-session.ts` registrations / `family/runtime.ts childSession`; never create another refresher | BUG-012 | New app shell or auth library | accepted |

## Tentative (not accepted)

- None.
