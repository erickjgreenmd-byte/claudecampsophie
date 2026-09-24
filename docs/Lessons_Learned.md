# PencilLift verified project lessons (spec E5.5, AC_ECC_11)

Accepted lessons only; each cites evidence. Project-scoped; never overrides requirements or permissions.

| Lesson ID | Trigger / scope | Proven root cause | Correction / prevention | Evidence | Revalidate when | Status |
|---|---|---|---|---|---|---|
| L-001 | Creating Postgres roles in migrations/test setup | Roles are cluster-wide; `if not exists` check-then-create races between concurrent sessions | Wrap `create role` in a DO block catching `duplicate_object` and `unique_violation` | BUG-001 | Postgres major upgrade | accepted |
| L-002 | Any new function in `app`/`public` | Postgres grants EXECUTE to PUBLIC by default, and `ALTER DEFAULT PRIVILEGES IN SCHEMA … REVOKE` cannot remove a global default (per-schema defaults only add). The first version of this lesson wrongly trusted the schema-level revoke | Global `ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` in 0001 + explicit revoke/grant per SECURITY DEFINER function; `schema_invariants.test.ts` fails if anon can execute any | BUG-002 | New schema, or migrations run by a different role | accepted (corrected) |
| L-003 | Any child (`pl_child`) query | Child access uses column-level grants; `select *` is denied (fail closed) rather than filtering columns | API child queries and DTO builders must name the allowlisted columns explicitly; tests assert both the allowlist and that `*`/forbidden columns are denied | `supabase/tests/learning.test.ts` (2 initial failures from `select *` in tests) | Child-readable columns change | accepted |
| L-004 | Any pre-commit check in shell | Piping a check into `grep`/`tail` discards its exit status; two type errors were committed this way (BUG-003, BUG-004) | Gate commits with `scripts/verify.sh` (pipefail, no filters); never chain `check | filter && git commit` | BUG-003, BUG-004 | Shell/CI changes | accepted |
| L-005 | Upserts with `ON CONFLICT … DO UPDATE … WHERE` guards | A guard that fails turns the write into a silent no-op; if later logic trusts in-memory state, data is silently wrong (BUG-006) | Add `RETURNING` and assert the row count; keys for provider objects must be globally unique (include the subscriber identity) | BUG-006 | Any new provider/external-id upsert | accepted |

## Tentative (not accepted)

- None.
