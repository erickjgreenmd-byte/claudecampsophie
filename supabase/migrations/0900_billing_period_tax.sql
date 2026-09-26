-- 0900: the invoice's sales tax, kept beside the charge it was added to (HUNT5-C-2).
--
-- `charged_amount_cents` is the PRE-TAX subscription amount, and only that amount is booked as
-- revenue (BILL-R2-4): US sales tax is a state's money, and a mid-cycle proration line sitting on a
-- renewal invoice is a separate period's charge. A provider refund amount, by contrast, is what the
-- family got back INCLUDING tax, so BILL-R4-3 converts it into the recorded charge's unit before it
-- is written to `refunded_cents` (net = gross - refunds only adds up when both are in one unit).
--
-- That conversion divided by the whole Stripe Charge, which is the invoice total: on a renewal that
-- also carried a $10 proration item, a $39.99 refund was scaled by 3999/4999 and recorded as 3199,
-- so 800 cents of a refund the family really received reversed nothing and the owner's net revenue
-- read 799 cents of kept subscription revenue for a period whose whole charge came back. The ratio
-- may only take the TAX off, never a share of lines that were never booked as revenue — so the tax
-- has to be stored with the period, because the refund webhook must not go back to the provider for
-- the invoice (an outbound call inside the webhook transaction, and a figure that may have changed).
--
-- Written by recordBillingPeriod at invoice.paid time from the share of the invoice's `tax` that
-- belongs to the SUBSCRIPTION line, not from the invoice's whole tax: on the same renewal the whole
-- 412 cents of tax covers the $10 proration too, and dividing by it left ~2% of the original defect
-- in the same direction. The share is `floor(tax * charged / (charged + every other line's amount))`,
-- which assumes the lines share one tax rate (the provider states tax per line, but the invoice shape
-- this code models carries only line amounts); flooring keeps the stored figure at or below the tax
-- really on this charge, so any error can only over-record a refund, never under-record one.
--
-- A period recorded BEFORE this migration has tax 0, which makes the ratio charged/(charged + 0) = 1
-- and the conversion an exact no-op: such a period keeps the provider's figure bounded by the cap at
-- the charge, the behaviour it already had. That is not a bug to chase — there is no tax figure for
-- a past invoice short of re-fetching it, and a no-op is the safe default because it can only
-- over-record a refund (net revenue understated), never under-record one.
alter table public.billing_periods
  add column if not exists tax_amount_cents integer not null default 0;

alter table public.billing_periods
  drop constraint if exists billing_periods_tax_amount_cents_non_negative;
alter table public.billing_periods
  add constraint billing_periods_tax_amount_cents_non_negative
  check (tax_amount_cents >= 0);

comment on column public.billing_periods.tax_amount_cents is
  'The share of the invoice''s sales tax that belongs to this period''s subscription line, in '
  'integer cents (HUNT5-C-2) — not the invoice''s whole tax, which on a renewal carrying a '
  'proration '
  'line also covers that line. NEVER revenue: it is stored only so a provider refund amount, which '
  'includes tax, can be stated in the same unit as charged_amount_cents by the ratio '
  'charged_amount_cents / (charged_amount_cents + tax_amount_cents). 0 for a channel that reports no '
  'tax, for an untaxed invoice, and for every period recorded before migration 0900 — the ratio is '
  'then 1 and the conversion a no-op.';

-- RLS, grants and the read policy come from migration 0200 and are table-wide: a family member (or
-- the owner admin) reads their own billing_periods rows, `authenticated` holds no insert/update/
-- delete and `anon` holds nothing at all. A column added to the table inherits all of that, so this
-- migration adds no policy and no grant; supabase/tests/billing_tax.test.ts asserts that the new
-- column really is reachable and writable on exactly those terms and no others.
