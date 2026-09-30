-- 0990: the owner's method for confirming an adult, as its OWN standard beside the biometric one.
--
-- OWNER DECISION (2026-09-30, reaffirmed after the cost of it was put to them in writing): "take the
-- license and along with the check now legal statement adding in that the license use the license to
-- confirm the age as an adult and that will be enough."
--
-- WHY A SECOND TABLE RATHER THAN A CHANGED COLUMN. The first draft of this migration redefined
-- `identity_verifications.adult_confirmed` to drop the face comparison. That is a redefinition: the
-- same column name would have meant a materially weaker thing, the 0980 test asserting that five
-- non-matching biometric answers refuse would have had to be re-aimed to say they now confirm, and a
-- reader six months from now would have had no way to tell which standard any given row met. Two
-- named standards in two tables cannot be confused; one column that quietly changed meaning can.
-- So `identity_verifications` and its tests are UNTOUCHED, and this is the owner's method as itself.
--
-- THE TWO STANDARDS, AND WHAT EACH IS WORTH:
--   * `identity_verifications.adult_confirmed` (0980) - government photo ID, an adult date of birth
--     on it, AND a face comparison matching the holder to the document. The stronger standard. It is
--     currently UNREACHABLE: the comparison is biometric identification, which no provider PencilLift
--     can reach will perform (the OpenAI adapter attempts it and records the refusal). Kept for the
--     day a vendor is contracted, not deleted.
--   * `identity_declarations.adult_declared` (here) - government photo ID, an adult date of birth on
--     it, AND the holder's legal declaration that they are the person shown on it and the child's
--     parent or guardian. This is what the product runs on now.
--
-- WHAT THE WEAKER STANDARD DOES NOT ESTABLISH, STATED HERE BECAUSE THIS IS WHAT THE OWNER SIGNS OFF
-- FROM. Reading a licence is not the FTC-approved ID method: 16 CFR 312.5(b)(2)(v) approves checking
-- government-issued identification against DATABASES of such information, with prompt deletion. A
-- vision model reading a licence checks it against nothing - it cannot tell a fabricated licence from
-- a real one, and it cannot tell whose hand is holding the phone. A child photographing a parent's
-- licence passes the document half, and so does anyone photographing any adult's. Two things narrow
-- that and neither closes it: the submitter's own stated date of birth is checked AGAINST the
-- document (DOB_MISMATCH), so they must know the holder's birth date; and the declaration carries the
-- legal consequence of a false statement. docs/Threat_Model.md T41 carries the residual.
--   The question counsel must answer for this to be sufficient is recorded as owner action #48:
-- whether sending homework to a ZDR-bound processor is a disclosure to a third party. If it is not,
-- the internal-use standard applies and is lower; if it is, the stronger standard is required and
-- this decision has to be revisited - which is exactly why the basis is recorded per adult below,
-- so only the affected adults would need re-verifying rather than all of them.
--
-- FAIL CLOSED IS UNCHANGED. `adult_declared` is GENERATED: no writer can assert it, and the
-- declaration is one of its three inputs rather than a flag a client sets beside them.

create table public.identity_declarations (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id) on delete cascade,
  adult_user_id uuid not null references auth.users (id),
  -- The adapter that read the document, and its own reference, so an audit traces to the provider.
  provider text not null,
  provider_reference text,
  -- Nothing read off the document is stored: no name, no address, no document number, no date of
  -- birth. Only these two answers about it, exactly as 0980 does.
  document_is_government_id boolean not null,
  document_holder_is_adult boolean not null,
  -- The legal declaration. Version AND instant, never a bare boolean: a claim with no version cannot
  -- be audited, and a later wording must not silently re-characterise what an adult agreed to.
  holder_attestation_version text,
  holder_attested_at timestamptz,
  -- Generated, so no writer can assert a standard the three inputs do not support.
  adult_declared boolean not null generated always as (
    document_is_government_id
    and document_holder_is_adult
    and holder_attestation_version is not null
  ) stored,
  -- Why a submission established nothing, for the adult's own screen. A short machine code, never
  -- provider prose and never anything read off the document.
  failure_code text check (failure_code is null or failure_code ~ '^[A-Z][A-Z0-9_]{2,39}$'),
  is_test_provider boolean not null,
  -- Proof the image is gone, recorded by the path that discarded it. NOT NULL: the row is written
  -- after the image is released, so it cannot exist without asserting the deletion.
  images_discarded_at timestamptz not null,
  checked_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint identity_declarations_attestation_complete
    check ((holder_attestation_version is null and holder_attested_at is null)
           or (holder_attestation_version is not null and holder_attested_at is not null)),
  constraint identity_declarations_established_names_no_failure
    check (not adult_declared or failure_code is null),
  constraint identity_declarations_unestablished_says_why
    check (adult_declared or failure_code is not null)
);

create index identity_declarations_family
  on public.identity_declarations (family_id, checked_at desc);
-- Looked up by the ADULT rather than the family: an adult who established this once is not asked
-- again when they are invited to a second family.
create index identity_declarations_established_adult
  on public.identity_declarations (adult_user_id, checked_at desc)
  where adult_declared;

alter table public.identity_declarations enable row level security;

create policy identity_declarations_read_own_family on public.identity_declarations
  for select to authenticated
  using (app.is_family_member(family_id));

revoke insert, update, delete on public.identity_declarations from authenticated, anon, pl_child;

-- ---------------------------------------------------------------------------------------------
-- Recording one, and the consent row an established adult earns
-- ---------------------------------------------------------------------------------------------

/**
 * Records one document-plus-declaration submission and, when it established an adult, the verified
 * consent row every existing gate reads. Both in ONE transaction, for the same reason 0980 does it:
 * an establishment that failed to write its consent row would leave the adult established by the
 * audit trail and refused by the product, and the reverse would leave consent standing with no
 * evidence behind it.
 *
 * p_now is the caller's stated clock, never now(): an instant comparison on an unstated clock is a
 * defect this project has paid for three times.
 */
create or replace function app.record_identity_declaration(
  p_family uuid,
  p_adult uuid,
  p_provider text,
  p_provider_reference text,
  p_document_is_government_id boolean,
  p_document_holder_is_adult boolean,
  p_holder_attestation_version text,
  p_failure_code text,
  p_is_test_provider boolean,
  p_policy_version text,
  p_now timestamptz
)
returns public.identity_declarations
language plpgsql security definer
set search_path = ''
as $$
declare
  rec public.identity_declarations;
begin
  insert into public.identity_declarations (
    family_id, adult_user_id, provider, provider_reference,
    document_is_government_id, document_holder_is_adult,
    holder_attestation_version, holder_attested_at,
    failure_code, is_test_provider, images_discarded_at, checked_at)
  values (
    p_family, p_adult, p_provider, p_provider_reference,
    p_document_is_government_id, p_document_holder_is_adult,
    p_holder_attestation_version,
    -- NULL exactly when there is no declaration, which the paired constraint enforces.
    case when p_holder_attestation_version is null then null else p_now end,
    p_failure_code, p_is_test_provider, p_now, p_now)
  returning * into rec;

  if rec.adult_declared then
    insert into public.consent_records (
      family_id, adult_user_id, provider, provider_reference, method, purpose,
      policy_version, scope, status, is_test_provider, verified_at)
    values (
      p_family, p_adult, p_provider, p_provider_reference,
      -- 'document_only' names HOW this adult was established, so an audit reading consent_records
      -- alone can tell this standard from a face-matched one without joining back.
      'document_only', 'child_data_processing', p_policy_version,
      jsonb_build_object(
        'identityDeclarationId', rec.id::text,
        'holderAttestationVersion', rec.holder_attestation_version,
        'basis', 'declared'),
      'verified', p_is_test_provider, p_now);
  end if;

  insert into public.audit_events (
    family_id, actor_user_id, actor_kind, action, target_type, target_id)
  values (
    p_family, p_adult, 'parent',
    case when rec.adult_declared then 'identity.declared' else 'identity.declaration_refused' end,
    'adult', p_adult::text);

  return rec;
end
$$;

revoke execute on function app.record_identity_declaration(
  uuid, uuid, text, text, boolean, boolean, text, text, boolean, text, timestamptz)
  from public, anon, authenticated, pl_child;
grant execute on function app.record_identity_declaration(
  uuid, uuid, text, text, boolean, boolean, text, text, boolean, text, timestamptz)
  to service_role;

/**
 * WHICH standard this adult has met, or null when neither: 'verified' for the biometric one,
 * 'declared' for the document-plus-declaration one. 'verified' wins when an adult has both, because
 * the stronger evidence is the one an audit should see.
 *
 * This exists so the weaker basis is never invisible. If counsel later requires the stronger standard
 * (owner action #48), this is the query that names exactly which adults must be re-verified.
 */
create or replace function public.adult_identity_basis(p_adult uuid)
returns text
language sql security definer
set search_path = ''
as $$
  select case
    when exists (select 1 from public.identity_verifications
                  where adult_user_id = p_adult and adult_confirmed) then 'verified'
    when exists (select 1 from public.identity_declarations
                  where adult_user_id = p_adult and adult_declared) then 'declared'
    else null
  end
$$;

/**
 * Whether this adult has met EITHER standard. The one predicate the API asks before it issues a
 * pairing code or takes a first payment, so a later change of standard is a change here and not in
 * every caller. Granted to `authenticated` so both clients can show an adult their own state.
 */
create or replace function public.adult_identity_established(p_adult uuid)
returns boolean
language sql security definer
set search_path = ''
as $$
  select public.adult_identity_basis(p_adult) is not null
$$;

revoke execute on function public.adult_identity_basis(uuid) from public, anon, pl_child;
grant execute on function public.adult_identity_basis(uuid) to authenticated, service_role;
revoke execute on function public.adult_identity_established(uuid) from public, anon, pl_child;
grant execute on function public.adult_identity_established(uuid) to authenticated, service_role;
