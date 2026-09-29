-- 0950: what a dispute added, kept apart from what was refunded (hardening round 7, HUNT7-C-2).
--
-- `refunded_cents` is one number for two different events. A chargeback ADDS the disputed amount on
-- top of whatever was refunded before it and caps the total at the charge
-- (`least(charged_amount_cents, refunded_cents + disputed)`, BILL-R1-1: a lost dispute must never
-- look like kept revenue), while a won dispute SUBTRACTS the disputed amount back out. Those two are
-- the same number only while `refunded_cents + disputed <= charged_amount_cents`. Migration 0900 and
-- HUNT6-C-2 made both figures share one unit, which is necessary and was assumed to be sufficient;
-- it is not. HUNT6-C-1's second period is exactly the shape where the cap bites: an invoice's
-- provider total is the subscription charge PLUS the pending proration net PLUS the whole invoice
-- tax, while the primary period's cap is its own charge alone. A family refunded $10 of a $39.99
-- renewal that carried a $10 deferred item, who then disputes the 3999 they did not get back and
-- wins, had the addition clipped to 2999 and the whole 3999 subtracted: `refunded_cents` landed at 0
-- and the settlement went back to 'settled'. Their real refund was gone from the record, their own
-- support case told them "the store has not reported a refund on this charge yet", the owner's net
-- revenue was overstated, and `planAdjustment` (which reinstates only on settled-with-nothing-
-- refunded) paid the school's $1 back for a month the family was partly refunded for.
--
-- What the dispute added is not recoverable from a single column once the cap has clipped it, so it
-- is stored. `chargeback_cents` is the part of `refunded_cents` that an OPEN dispute contributed:
-- a chargeback adds `min(disputed, charged_amount_cents - refunded-part)` and records exactly that,
-- and `chargeback_reversed` gives back exactly that and no more, so any earlier genuine refund
-- survives the win untouched. The cap is unchanged and no BILL-R1-1 assertion is weakened: every
-- per-row figure is still at most that row's charge.
--
-- The invariant the arithmetic maintains, and the checks below enforce: the genuine refund part is
-- `refunded_cents - chargeback_cents`, so 0 <= chargeback_cents <= refunded_cents <= charged. A
-- write that would break it fails loudly rather than letting a reversal subtract money no dispute
-- ever added. Every row written before this migration has 0, which is the pre-0950 behaviour exactly:
-- with nothing attributed to a dispute, a reversal gives back nothing until a chargeback records
-- something.
alter table public.billing_periods
  add column if not exists chargeback_cents integer not null default 0;

alter table public.billing_periods
  drop constraint if exists billing_periods_chargeback_cents_non_negative;
alter table public.billing_periods
  add constraint billing_periods_chargeback_cents_non_negative
  check (chargeback_cents >= 0);

alter table public.billing_periods
  drop constraint if exists billing_periods_chargeback_cents_within_refund;
alter table public.billing_periods
  add constraint billing_periods_chargeback_cents_within_refund
  check (chargeback_cents <= refunded_cents);

comment on column public.billing_periods.chargeback_cents is
  'How much of refunded_cents an OPEN provider dispute contributed, in integer cents and in '
  'charged_amount_cents'' pre-tax unit (HUNT7-C-2). NEVER revenue and never a second refund figure: '
  'refunded_cents is the whole amount clawed back and this is the part of it a chargeback added, so '
  'refunded_cents - chargeback_cents is what the family was genuinely refunded. A won dispute '
  '(chargeback_reversed) gives back exactly this and sets it to 0, which is what keeps an earlier '
  'partial refund on the record when the cap clipped the addition. 0 for every row written before '
  'migration 0950 and for every period no dispute has touched.';

-- HUNT7-C-4: the tax column now holds a share on the SECOND period of an invoice too, so its 0900
-- comment (which named the subscription line alone) is restated here rather than left to mislead.
comment on column public.billing_periods.tax_amount_cents is
  'The share of the invoice''s sales tax that belongs to THIS period''s charge, in integer cents '
  '(HUNT5-C-2 / N1-TAX-APPORTION) — not the invoice''s whole tax, which on a renewal carrying a '
  'proration line also covers that line. Both periods one invoice can write carry their own share: '
  'the subscription charge''s, and (HUNT7-C-4) the ''<invoice>:proration'' row''s, because the figure '
  'that reaches that row is the leftover of the provider''s tax-INCLUSIVE amount and it has to be '
  'restated in the row''s own pre-tax unit like any other. Each share is FLOORED, so no row ever '
  'stores more tax than was levied on it and the conversion can only over-record a refund, never '
  'under-record one. NEVER revenue: it is stored only so a provider refund amount, which includes '
  'tax, can be stated in the same unit as charged_amount_cents by the ratio charged_amount_cents / '
  '(charged_amount_cents + tax_amount_cents). 0 for a channel that reports no tax, for an untaxed '
  'invoice, and for every period recorded before migration 0900 — the ratio is then 1 and the '
  'conversion a no-op.';

-- RLS, grants and the read policy come from migration 0200 and are table-wide: a family member (or
-- the owner admin) reads their own billing_periods rows, `authenticated` holds no insert/update/
-- delete and `anon` holds nothing at all. A column added to the table inherits all of that, so this
-- migration adds no policy and no grant; supabase/tests/billing_tax.test.ts asserts that the new
-- column really is reachable and writable on exactly those terms and no others.
