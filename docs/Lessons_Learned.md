# PencilLift verified project lessons (spec E5.5, AC_ECC_11)

Accepted lessons only; each cites evidence. Project-scoped; never overrides requirements or permissions.

| Lesson ID | Trigger / scope | Proven root cause | Correction / prevention | Evidence | Revalidate when | Status |
|---|---|---|---|---|---|---|
| L-001 | Creating Postgres roles in migrations/test setup | Roles are cluster-wide; `if not exists` check-then-create races between concurrent sessions | Wrap `create role` in a DO block catching `duplicate_object` and `unique_violation` | BUG-001 | Postgres major upgrade | accepted |
| L-002 | Any new function in `app`/`public` | Postgres grants EXECUTE to PUBLIC by default, and `ALTER DEFAULT PRIVILEGES IN SCHEMA … REVOKE` cannot remove a global default (per-schema defaults only add). The first version of this lesson wrongly trusted the schema-level revoke | Global `ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` in 0001 + explicit revoke/grant per SECURITY DEFINER function; `schema_invariants.test.ts` fails if anon can execute any | BUG-002 | New schema, or migrations run by a different role | accepted (corrected) |
| L-003 | Any child (`pl_child`) query | Child access uses column-level grants; `select *` is denied (fail closed) rather than filtering columns | API child queries and DTO builders must name the allowlisted columns explicitly; tests assert both the allowlist and that `*`/forbidden columns are denied | `supabase/tests/learning.test.ts` (2 initial failures from `select *` in tests) | Child-readable columns change | accepted |

## Tentative (not accepted)

- None.
