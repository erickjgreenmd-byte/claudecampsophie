-- 0980: the adult ID check that has to pass before any child code is issued.
--
-- THE OWNER'S FLOW, in the order they specified it:
--   1. the adult registers and gives their date of birth,
--   2. they photograph a government ID and take a selfie,
--   3. the system checks the ID is a real government document, reads its date of birth, and checks
--      the selfie is the same person,
--   4. the images are DELETED,
--   5. the adult lists the children they want codes for and ticks the parent/guardian statement for
--      each one (migration 0970),
--   6. payment is taken,
--   7. one pairing code is issued per child.
--
-- WHAT THIS TABLE IS, AND IS NOT. It is the AUDIT TRAIL of step 3: which adult was checked, by which
-- provider, at which instant, and what the two independent checks answered. It is deliberately NOT a
-- copy of anything on the document. There is no image column, no face template, no document number,
-- no name, no address and no date of birth — only `document_is_government_id` and `adult_confirmed`,
-- which are the two BOOLEANS the product actually needs. The reasons, in order of how much they cost
-- if ignored:
--   * A face template is biometric data. Illinois BIPA, Texas CUBI and Washington's statute all
--     attach notice-and-written-consent duties and, in Illinois, statutory damages PER VIOLATION to
--     storing one. Storing none removes the exposure rather than managing it.
--   * A driver's licence number plus a name plus a date of birth is identity-theft material, and a
--     breach of it is reportable in every US state. Storing none removes the notification duty.
--   * COPPA asks for the verification to happen; it does not ask for the evidence to be kept. FTC
--     guidance on the face-match-to-photo-ID method (approved 2023) is explicit that the images are
--     to be deleted promptly after the comparison.
-- `supabase/tests/identity_verification.test.ts` asserts the column list, so a later migration that
-- adds an image, a template, a document number or a date of birth reds rather than shipping.
--
-- WHY IT IS A SEPARATE TABLE FROM public.consent_records. consent_records answers "may PencilLift
-- process this family's children's work?" — one row per family per purpose, withdrawable. This
-- answers "was this ADULT's identity checked, and how?" — one row per attempt, including the
-- failures, which is what an audit asks to see. On success `app.record_identity_verification` writes
-- BOTH: the attempt here and a `verified` consent_records row with method 'document_and_selfie'. That
-- is what makes every gate already in the product start refusing without this check, rather than
-- needing a new gate in each of them (L-037: the same pre-check on every surface, by construction).
--
-- FAIL CLOSED. `adult_confirmed` is generated, not supplied: it is true only when the document was a
-- government ID AND the face comparison came back 'matched'. A provider that cannot compare faces
-- returns 'not_attempted' or 'refused' and the row is not confirmed, so no consent row is written and
-- no code is issued. There is no configuration that turns a partial check into a pass.

create table public.identity_verifications (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families (id) on delete cascade,
  adult_user_id uuid not null references auth.users (id),
  -- The provider that ran the check and its own reference, so an audit can be traced to the vendor.
  provider text not null,
  provider_reference text,
  -- How the check was made. 'document_and_selfie' is the owner's flow; the others exist so a future
  -- method is recorded as itself rather than mislabelled as this one.
  method text not null check (method in ('document_and_selfie', 'document_only', 'vendor_hosted')),
  -- Did the provider judge the first image to be a genuine government-issued photo ID?
  document_is_government_id boolean not null,
  -- Did the document's own date of birth put the holder at or over the adult age at the instant of
  -- the check? The date itself is not stored — only this answer.
  document_holder_is_adult boolean not null,
  -- The face comparison between the ID portrait and the selfie. Five of the six values are NOT a pass,
  -- and each says a different thing, because collapsing them would record a claim no provider made:
  --   'matched'        the provider judged them the same person. The only value that can confirm.
  --   'not_matched'    the provider judged them DIFFERENT people. A finding, not an absence.
  --   'inconclusive'   the provider compared them and could not decide. Not a finding either way, and
  --                    the one non-pass a better selfie may resolve, so it is the parent's to retry.
  --   'not_attempted'  no comparison was made (an earlier check failed first, so there was no point).
  --   'refused'        the provider declined the question. A provider whose policy forbids biometric
  --                    comparison answers this, and it must never be read as a pass.
  --   'error'          a provider or transport failure.
  face_match text not null check (face_match in
    ('matched', 'not_matched', 'inconclusive', 'not_attempted', 'refused', 'error')),
  -- Generated, so no writer can assert a confirmation the two checks do not support.
  adult_confirmed boolean not null generated always as (
    document_is_government_id and document_holder_is_adult and face_match = 'matched'
  ) stored,
  -- Why a check did not confirm, for the parent's own screen. A short machine code, never provider
  -- prose and never anything read off the document.
  failure_code text check (failure_code is null or failure_code ~ '^[A-Z][A-Z0-9_]{2,39}$'),
  -- True for the labeled development double. Production readiness refuses these rows, exactly as it
  -- does for consent_records.is_test_provider.
  is_test_provider boolean not null,
  -- Proof the images are gone, recorded by the code path that discarded them. NOT NULL: a row cannot
  -- exist without asserting the deletion, because the row is written after the images are released.
  images_discarded_at timestamptz not null,
  checked_at timestamptz not null,
  created_at timestamptz not null default now(),
  -- A confirmed row names no failure, and an unconfirmed one must say why.
  check (not adult_confirmed or failure_code is null),
  check (adult_confirmed or failure_code is not null)
);

create index identity_verifications_family
  on public.identity_verifications (family_id, checked_at desc);
-- The one confirmed check per adult that gates everything, looked up by the adult rather than by the
-- family: an adult who verified once is not asked again when they are invited to a second family.
create index identity_verifications_confirmed_adult
  on public.identity_verifications (adult_user_id, checked_at desc)
  where adult_confirmed;

alter table public.identity_verifications enable row level security;

-- An adult reads their own family's attempts and writes none. Every write goes through
-- app.record_identity_verification, which is service-role only: the outcome of an identity check is
-- not a value a client may assert, and `authenticated` reaches this table through the Data API.
create policy identity_verifications_read_own_family on public.identity_verifications
  for select to authenticated
  using (app.is_family_member(family_id));

revoke insert, update, delete on public.identity_verifications from authenticated, anon, pl_child;

-- ---------------------------------------------------------------------------------------------
-- Recording an attempt, and the consent row a confirmed one earns
-- ---------------------------------------------------------------------------------------------

/**
 * Records one identity-check attempt and, when it confirmed an adult, the verified consent row that
 * every existing gate reads. Both in ONE transaction: a confirmation that failed to write its consent
 * row would leave the adult verified by the audit trail and refused by the product, and the reverse
 * would leave consent standing with no evidence behind it.
 *
 * p_now is the caller's stated clock (the application's), never now(): an instant comparison on an
 * unstated clock is a defect this project has paid for three times (BUG-090, the round-7 retention
 * step, and 0960's inactivity arm).
 */
create or replace function app.record_identity_verification(
  p_family uuid,
  p_adult uuid,
  p_provider text,
  p_provider_reference text,
  p_method text,
  p_document_is_government_id boolean,
  p_document_holder_is_adult boolean,
  p_face_match text,
  p_failure_code text,
  p_is_test_provider boolean,
  p_policy_version text,
  p_now timestamptz
)
returns public.identity_verifications
language plpgsql security definer
set search_path = ''
as $$
declare
  rec public.identity_verifications;
begin
  insert into public.identity_verifications (
    family_id, adult_user_id, provider, provider_reference, method,
    document_is_government_id, document_holder_is_adult, face_match,
    failure_code, is_test_provider, images_discarded_at, checked_at)
  values (
    p_family, p_adult, p_provider, p_provider_reference, p_method,
    p_document_is_government_id, p_document_holder_is_adult, p_face_match,
    p_failure_code, p_is_test_provider, p_now, p_now)
  returning * into rec;

  if rec.adult_confirmed then
    -- The consent row is what the rest of the product reads (services/consent.ts
    -- consentAllowsChildAccess, and through it the pairing-code route, the job gates and child
    -- access). method names HOW the adult was verified so an audit can tell a document check from a
    -- hosted vendor flow; provider carries the adapter that ran it.
    insert into public.consent_records (
      family_id, adult_user_id, provider, provider_reference, method, purpose,
      policy_version, scope, status, is_test_provider, verified_at)
    values (
      p_family, p_adult, p_provider, p_provider_reference, p_method, 'child_data_processing',
      p_policy_version,
      jsonb_build_object('identityVerificationId', rec.id::text),
      'verified', p_is_test_provider, p_now);
  end if;

  insert into public.audit_events (
    family_id, actor_user_id, actor_kind, action, target_type, target_id)
  values (
    p_family, p_adult, 'parent',
    case when rec.adult_confirmed then 'identity.confirmed' else 'identity.refused' end,
    'adult', p_adult::text);

  return rec;
end
$$;

revoke execute on function app.record_identity_verification(
  uuid, uuid, text, text, text, boolean, boolean, text, text, boolean, text, timestamptz)
  from public, anon, authenticated, pl_child;
grant execute on function app.record_identity_verification(
  uuid, uuid, text, text, text, boolean, boolean, text, text, boolean, text, timestamptz)
  to service_role;

/**
 * Whether this adult has a confirmed identity check. Read by the API before it issues a pairing code
 * and before it takes the first payment, and granted to `authenticated` so the portal and the app can
 * show the adult their own state without a round trip through a service-role path.
 */
create or replace function public.adult_identity_confirmed(p_adult uuid)
returns boolean
language sql security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.identity_verifications
     where adult_user_id = p_adult and adult_confirmed)
$$;

revoke execute on function public.adult_identity_confirmed(uuid) from public, anon, pl_child;
grant execute on function public.adult_identity_confirmed(uuid) to authenticated, service_role;
