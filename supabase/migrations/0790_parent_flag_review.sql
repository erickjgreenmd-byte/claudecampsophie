-- 0790_parent_flag_review.sql
-- Parent as the safety recipient (owner decision, 2026-09-25; the lead's dissent is recorded in
-- docs/Threat_Model.md). The parent is the only person PencilLift sends a safety message to, and
-- the parent addresses the concern:
--   1. No safety flag is held from the family. The hold mechanism (0760 family_visible, the admin
--      release) stays in the schema and the API, unused: the API never files a held report.
--   2. When the scan job files a system report it enqueues a 'safety_flag_email' job. The job emails
--      every active guardian (no homework text, no child name, no category: only that PencilLift
--      flagged an answer for them to look at, and where) and records the delivery here, so the
--      family's list says truthfully whether an email was sent.
--   3. A guardian can act on a flag from the portal or the app after a recent PIN unlock:
--      'addressed' ("I've looked into this": resolved, the child's notice stays, no AI on that
--      question) or 'false_match' ("a false alarm": the same clearing as the reviewer's, the notice
--      is hidden and the question rechecked). The parent's action is stamped in parent_action_*.
--      The owner admin queue and its clearing stay as a support tool.
-- Every write below is the API's, as the service role after its own checks: `authenticated` keeps
-- no update grant on safety_reports (0600 revoked it), so a client cannot resolve, clear or
-- "mark emailed" a report through the Data API. RLS is unchanged.

-- ---------------------------------------------------------------------------------------------
-- 1. Outcomes: 'addressed' joins 'false_match'
-- ---------------------------------------------------------------------------------------------

alter table public.safety_reports drop constraint safety_reports_resolution_check;
alter table public.safety_reports add constraint safety_reports_resolution_check
  check (resolution in ('false_match', 'addressed'));

-- A resolution belongs to a resolved report: a false match to a system report only (the flagged
-- question is rechecked); 'addressed' to a system report or a child's report (the concern is with
-- the family; a parent's own report is closed by the reviewer).
alter table public.safety_reports drop constraint safety_reports_resolution_shape;
alter table public.safety_reports add constraint safety_reports_resolution_shape check (
  resolution is null
  or (
    status = 'resolved'
    and (
      (resolution = 'false_match' and reporter_kind = 'system')
      or (resolution = 'addressed' and reporter_kind in ('system', 'child'))
    )
  )
);

-- ---------------------------------------------------------------------------------------------
-- 2. The parent's action and the guardian email
-- ---------------------------------------------------------------------------------------------

alter table public.safety_reports
  -- When a guardian resolved this report from the portal or the app, and who (pseudonymous id; a
  -- deleted account leaves the stamp without the actor).
  add column parent_action_at timestamptz,
  add column parent_action_by uuid references auth.users (id) on delete set null,
  -- When at least one active guardian's address accepted the flag email (the job's clock), and the
  -- state the family list shows: 'not_sent' until the job runs (or when no verified address
  -- exists), 'sent', or 'failed' (the provider refused; the job retries a bounded number of times).
  add column parent_emailed_at timestamptz,
  add column parent_email_status text not null default 'not_sent'
    check (parent_email_status in ('sent', 'not_sent', 'failed'));

-- A parent's action is a resolution (never a bare stamp), and an actor implies an action.
alter table public.safety_reports add constraint safety_reports_parent_action_shape check (
  (parent_action_at is null or resolution is not null)
  and (parent_action_by is null or parent_action_at is not null)
);

-- 'sent' and the delivery instant are one fact.
alter table public.safety_reports add constraint safety_reports_parent_email_shape check (
  (parent_email_status = 'sent') = (parent_emailed_at is not null)
);

-- Families read the action stamp and the email state of their (visible) reports; the acting
-- guardian's id and the screen columns stay ungranted (0760). Still no update grant.
grant select (parent_action_at, parent_emailed_at, parent_email_status)
  on public.safety_reports to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. The guardian email is durable work in the job ledger
-- ---------------------------------------------------------------------------------------------

-- The 0600 list, unchanged since, plus 'safety_flag_email' (payload: the report id only).
alter table public.jobs drop constraint jobs_kind_check;
alter table public.jobs add constraint jobs_kind_check check (kind in (
  'scan_process', 'daily_set_generate', 'thursday_review_generate', 'review_top_up',
  'promo_month_generate', 'promo_offer_provision', 'promo_reconcile', 'donation_accrue',
  'payout_prepare', 'entitlement_reconcile', 'retention_purge', 'deletion_purge',
  'notification_send', 'export_build', 'safety_flag_email'));
