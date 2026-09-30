-- ---------------------------------------------------------------------------------------------
-- Parental/guardian attestation, per child (spec P3, AC_ACCESS_01/02; docs/design/Consent_Design.md)
-- ---------------------------------------------------------------------------------------------
--
-- Verifiable parental consent is TWO claims and the schema only carried one.
--
--   * That the consenting person is an ADULT is established by the consent provider, and
--     public.consent_records already records it: provider, provider_reference, method, verified_at.
--   * That this adult is the child's PARENT OR LEGAL GUARDIAN is established by nothing an identity
--     check can produce. No COPPA-enumerated verification method verifies a family relationship,
--     because no database of who is whose parent exists; the regulation contemplates the adult's own
--     assertion, and that assertion therefore does real legal work. It had no field.
--
-- It lives on the CHILD rather than on the consent record because it is made per child: the consent
-- is to the processing of THAT child's data, and a child added a year after signup was never named in
-- anything the parent agreed to. The adult verification stays per adult and is not repeated.
--
-- Enforced in the DATABASE and not only in the handler, because `authenticated` can reach
-- public.child_profiles through the Data API: a child may not be `active` without an attestation, so
-- the state that grants a paid slot and lets a device pair cannot be reached without one. That is the
-- same lesson as 0890 (a write the Data API can reach that the database does not backstop).

alter table public.child_profiles
  add column attestation_version text,
  add column attested_at timestamptz,
  add column attested_by uuid references auth.users (id);

-- All three or none: a version without an instant, or an instant with no adult behind it, is not an
-- attestation anyone could produce at an audit.
alter table public.child_profiles
  add constraint child_profiles_attestation_complete
  check (
    (attestation_version is null and attested_at is null and attested_by is null)
    or (attestation_version is not null and attested_at is not null and attested_by is not null)
  );

-- The gate. `draft` and `archived` may sit unattested (a draft has no paid slot and cannot pair; an
-- archived profile is history), but `active` is the status that opens the product to a child.
alter table public.child_profiles
  add constraint child_profiles_active_requires_attestation
  check (status <> 'active' or attested_at is not null);

comment on column public.child_profiles.attestation_version is
  'Version of the parental/guardian statement the adult agreed to (contracts CONSENT_ATTESTATION_VERSION). The wording itself is versioned in the repository, so the version plus the instant reconstructs exactly what was agreed.';
comment on column public.child_profiles.attested_at is
  'When the adult made the attestation for THIS child. Never a default: it is the instant the request carried.';
comment on column public.child_profiles.attested_by is
  'The adult who attested. Several guardians can share a family, so which one made the claim is part of the record.';
