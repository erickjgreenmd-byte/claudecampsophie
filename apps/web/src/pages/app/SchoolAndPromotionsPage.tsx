import { useCallback, useId, useState, type FormEvent, type ReactNode } from 'react';
import type { z } from 'zod';
import {
  familyPromotionsResponseSchema,
  familySchoolResponseSchema,
  listSchoolsResponseSchema,
  promoQuoteResponseSchema,
  promoRedemptionSchema,
  type channelSchema,
  type redemptionStateSchema,
  type schoolSummarySchema,
} from '@pencillift/contracts';
import type { ApiRequestError } from '@pencillift/contracts/client';
import { DEFAULT_MAX_PAID_SLOTS, formatUsd, priceTable } from '@pencillift/domain';
import { ErrorState, Loading } from '../../components/states.tsx';
import { RequireParent, useApiQuery, useSession } from '../../lib/session.tsx';
import { buttonRow, sectionStyle, StepUpNotice, toApiError, useLastGood } from './SecurityPage.tsx';

/**
 * Parent school designation and monthly promo codes (spec P17 parent interfaces; AC_PROMO_14,
 * AC_UX_01/02). One school per family; a change starts next program month. Every monthly code is
 * entered fresh, covers exactly one billing period, and is shown as a preview until the store
 * confirms it. The page shows what the API returns and never computes prices itself.
 */
export default function SchoolAndPromotionsPage() {
  return (
    <RequireParent>
      <h1>School and promotions</h1>
      <p>
        Choose the school your family supports and use this month’s PencilLift promo code, if you
        have one. Codes and school settings are for grown-ups only.
      </p>
      <SchoolSection />
      <ContributionExplainer />
      <PromoSection />
    </RequireParent>
  );
}

type Channel = z.infer<typeof channelSchema>;
type SchoolSummary = z.infer<typeof schoolSummarySchema>;
type FamilySchool = z.infer<typeof familySchoolResponseSchema>;
type Quote = z.infer<typeof promoQuoteResponseSchema>;
type Redemption = z.infer<typeof promoRedemptionSchema>;
type RedemptionState = z.infer<typeof redemptionStateSchema>;

// ---------------------------------------------------------------------------------------------
// Formatting (deterministic: calendar months are labelled without any timezone arithmetic)
// ---------------------------------------------------------------------------------------------

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function monthParts(month: string): { year: string; name: string } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  const name = match ? MONTHS[Number(match[2]) - 1] : undefined;
  return match && name ? { year: match[1]!, name } : null;
}

/** "2026-10" -> "October 2026". */
function monthLabel(month: string): string {
  const parts = monthParts(month);
  return parts ? `${parts.name} ${parts.year}` : month;
}

/** "2026-10" -> "October 1, 2026": the first day of a program month. */
function monthStartLabel(month: string): string {
  const parts = monthParts(month);
  return parts ? `${parts.name} 1, ${parts.year}` : month;
}

/**
 * Decision: billing-period instants are shown as a date in the viewer's own timezone, which is how
 * their store receipt shows it. Amounts are always formatted from integer cents.
 */
function longDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function schoolPlace(s: SchoolSummary): string {
  const place = [s.city, s.region].filter((x): x is string => Boolean(x)).join(', ');
  return place ? `${s.name} (${place})` : s.name;
}

// ---------------------------------------------------------------------------------------------
// Error wording (clients branch on the stable code/rule, never on server text)
// ---------------------------------------------------------------------------------------------

/** Friendly, specific explanations for the promo business rules (spec P17). */
const PROMO_RULE_MESSAGES: Readonly<Record<string, string>> = {
  CODE_INVALID_FORMAT:
    'That doesn’t look like a PencilLift code. Check that you typed it exactly as shown.',
  CODE_CHECKSUM_MISMATCH: 'That code has a typo. Check each character and try again.',
  CAMPAIGN_NOT_ACTIVE: 'This code isn’t active right now.',
  OUTSIDE_REDEMPTION_WINDOW: 'This code can only be used during its redemption dates.',
  CODE_REVOKED: 'This code is no longer valid.',
  CODE_USAGE_CAP_REACHED: 'This code has reached its usage limit.',
  CAMPAIGN_REDEMPTION_CAP_REACHED: 'This month’s promotion has reached its limit.',
  CAMPAIGN_BUDGET_EXHAUSTED: 'This month’s promotion is fully used.',
  SCHOOL_AUDIENCE_MISMATCH: 'This code is for families supporting a different school.',
  TIER_NOT_ELIGIBLE: 'This code doesn’t apply to your plan size.',
  SUBSCRIBER_NOT_ELIGIBLE:
    'This code isn’t available for your subscription status (new, current or returning).',
  CHANNEL_UNAVAILABLE:
    'This code isn’t available for the store you chose yet. Check that you picked the store that bills your subscription, or try again later.',
  CHANNEL_MISMATCH:
    'Your subscription is billed by a different store. Choose that store and try again.',
  FAMILY_ALREADY_REDEEMED_CAMPAIGN:
    'Your family already used this month’s code. Each monthly code works once per family — next month brings a new code.',
  PENDING_PROMOTION_EXISTS:
    'You already have a discount waiting for an upcoming billing period. You can use a new code after that one has been applied.',
  SUBSCRIPTION_NOT_IN_GOOD_STANDING:
    'Please resolve your subscription’s billing with your store before using a code.',
  NEXT_PERIOD_ALREADY_FINALIZED:
    'Your next bill is already final, so it can’t be discounted. Try a new code after it renews.',
  TARGET_PERIOD_ALREADY_DISCOUNTED:
    'That billing period already has a discount. Only one discount can apply to a billing period.',
};

function promoErrorMessage(error: ApiRequestError): string {
  if (error.code === 'BUSINESS_RULE' && error.rule) {
    return PROMO_RULE_MESSAGES[error.rule] ?? error.message;
  }
  if (error.code === 'NOT_FOUND') return 'That code isn’t valid. Check it and try again.';
  if (error.code === 'CHILD_MODE_FORBIDDEN') return 'Promo codes can only be used by a grown-up.';
  return error.message;
}

function PromoError({ error, action }: { error: ApiRequestError; action: string }) {
  if (error.code === 'STEP_UP_REQUIRED') return <StepUpNotice action={action} />;
  return <ErrorState message={promoErrorMessage(error)} />;
}

// ---------------------------------------------------------------------------------------------
// School designation
// ---------------------------------------------------------------------------------------------

function SchoolSection() {
  const headingId = useId();
  const query = useApiQuery((api) => api.get('/v1/family/school', familySchoolResponseSchema), []);
  const [saved, setSaved] = useState<FamilySchool | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const loaded = useLastGood(query);
  const data = saved ?? loaded;

  const onSaved = useCallback((next: FamilySchool, chosen: SchoolSummary) => {
    setSaved(next);
    setMessage(savedMessage(next, chosen));
  }, []);

  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>Your school</h2>
      {data === null && query.status === 'loading' ? (
        <Loading label="Loading your school…" />
      ) : null}
      {data === null && query.status === 'error' ? (
        <ErrorState
          message={
            query.error.code === 'NOT_FOUND'
              ? 'Create your family first, then come back to choose a school.'
              : query.error.message
          }
          {...(query.error.code === 'NOT_FOUND' ? {} : { onRetry: query.reload })}
        />
      ) : null}
      {data ? (
        <>
          <Designation data={data} onSaved={onSaved} />
          {message ? (
            <p role="status" style={{ color: 'var(--success)', fontWeight: 700 }}>
              {message}
            </p>
          ) : null}
          <p>
            <strong>One school per family; a change starts next month.</strong> The current month
            stays with the school you had at its start. Months follow {data.programTimezone} time.
          </p>
          <SchoolSearch data={data} onSaved={onSaved} />
        </>
      ) : null}
    </section>
  );
}

function savedMessage(next: FamilySchool, chosen: SchoolSummary): string {
  if (next.pending?.school.id === chosen.id) {
    return `Saved. ${chosen.name} becomes your school on ${monthStartLabel(next.pending.effectiveFromMonth)}.`;
  }
  if (next.current?.id === chosen.id) {
    return `Saved. ${chosen.name} stays your school${next.pending ? '' : ' with no change pending'}.`;
  }
  return 'Saved.';
}

function Designation({
  data,
  onSaved,
}: {
  data: FamilySchool;
  onSaved: (next: FamilySchool, chosen: SchoolSummary) => void;
}) {
  const { api } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);

  const keepCurrent = async (current: SchoolSummary) => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.send(
        'PUT',
        '/v1/family/school',
        { schoolId: current.id },
        familySchoolResponseSchema,
      );
      onSaved(next, current);
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {data.current ? (
        <p>
          Current school: <strong>{schoolPlace(data.current)}</strong>
        </p>
      ) : (
        <p>
          <strong>No school chosen yet.</strong> There is no school contribution until you choose
          one.
        </p>
      )}
      {data.pending ? (
        <div className="notice">
          <p style={{ margin: 0 }}>
            Changing to <strong>{schoolPlace(data.pending.school)}</strong> from{' '}
            {monthStartLabel(data.pending.effectiveFromMonth)}.
            {data.current ? ` ${data.current.name} stays your school until then.` : ''}
          </p>
          {data.current ? (
            <div style={buttonRow}>
              <button
                type="button"
                className="btn secondary"
                disabled={busy}
                onClick={() => data.current && void keepCurrent(data.current)}
              >
                {busy ? 'Saving…' : `Keep ${data.current.name} (cancel the change)`}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {error ? <PromoError error={error} action="Changing your school" /> : null}
    </>
  );
}

function SchoolSearch({
  data,
  onSaved,
}: {
  data: FamilySchool;
  onSaved: (next: FamilySchool, chosen: SchoolSummary) => void;
}) {
  const { api } = useSession();
  const inputId = useId();
  const [text, setText] = useState('');
  const [results, setResults] = useState<{ query: string; schools: SchoolSummary[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const [choosing, setChoosing] = useState<SchoolSummary | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const search = async (event: FormEvent) => {
    event.preventDefault();
    const q = text.trim();
    if (q.length < 2) {
      setFieldError('Type at least 2 letters of the school’s name.');
      return;
    }
    setFieldError(null);
    setSearching(true);
    setError(null);
    setChoosing(null);
    try {
      const found = await api.get(
        `/v1/schools?query=${encodeURIComponent(q)}`,
        listSchoolsResponseSchema,
      );
      setResults({ query: q, schools: found.schools });
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setSearching(false);
    }
  };

  const confirm = async (chosen: SchoolSummary) => {
    setSaving(true);
    setError(null);
    try {
      const next = await api.send(
        'PUT',
        '/v1/family/school',
        { schoolId: chosen.id },
        familySchoolResponseSchema,
      );
      setChoosing(null);
      setResults(null);
      setText('');
      onSaved(next, chosen);
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setSaving(false);
    }
  };

  const hintId = `${inputId}-hint`;
  return (
    <>
      <form onSubmit={(e) => void search(e)} noValidate role="search">
        <label htmlFor={inputId}>Find your school</label>
        <input
          id={inputId}
          value={text}
          maxLength={80}
          autoComplete="off"
          aria-describedby={fieldError ? hintId : undefined}
          onChange={(e) => {
            setText(e.target.value);
            setFieldError(null);
          }}
        />
        {fieldError ? (
          <p id={hintId} role="alert" style={{ color: 'var(--danger)', margin: '4px 0 0' }}>
            {fieldError}
          </p>
        ) : null}
        <div style={buttonRow}>
          <button type="submit" className="btn secondary" disabled={searching}>
            {searching ? 'Searching…' : 'Search'}
          </button>
        </div>
      </form>
      {results && results.schools.length === 0 ? (
        <p role="status">
          No schools match “{results.query}”. Only schools PencilLift has verified appear here.
        </p>
      ) : null}
      {results && results.schools.length > 0 ? (
        <ul aria-label="School search results" style={{ listStyle: 'none', padding: 0 }}>
          {results.schools.map((s) => (
            <li key={s.id} style={{ borderTop: '1px solid #e3e8ee', padding: '8px 0' }}>
              <span>{schoolPlace(s)}</span>{' '}
              {data.current?.id === s.id && !data.pending ? (
                <em>(your current school)</em>
              ) : (
                <button
                  type="button"
                  className="btn secondary"
                  disabled={saving}
                  aria-label={`Choose ${s.name}`}
                  onClick={() => setChoosing(s)}
                >
                  Choose
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {choosing ? (
        <div className="notice" role="group" aria-label="Confirm school">
          <p style={{ margin: 0 }}>
            Choose <strong>{choosing.name}</strong>?{' '}
            {data.current || data.pending
              ? 'A change starts on the first day of next month; this month stays with your current school.'
              : 'If you haven’t chosen a school before, it applies from this month. Otherwise a change starts on the first day of next month.'}
          </p>
          <div style={buttonRow}>
            <button
              type="button"
              className="btn"
              disabled={saving}
              aria-label={`Confirm ${choosing.name}`}
              onClick={() => void confirm(choosing)}
            >
              {saving ? 'Saving…' : 'Confirm'}
            </button>
            <button
              type="button"
              className="btn secondary"
              disabled={saving}
              onClick={() => setChoosing(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {error ? <PromoError error={error} action="Changing your school" /> : null}
    </>
  );
}

function ContributionExplainer() {
  const headingId = useId();
  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>How the school contribution works</h2>
      <ul>
        <li>
          PencilLift contributes $1/month for each month your family pays full price, to the one
          school you choose.
        </li>
        <li>Discounted months (any code, 5%–100%) contribute $0.</li>
        <li>
          The contribution is funded by PencilLift. It is not an extra charge to you and not a
          tax-deductible donation by you.
        </li>
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Promo codes
// ---------------------------------------------------------------------------------------------

const CHANNEL_NAME: Record<Channel, string> = {
  app_store: 'App Store',
  play_store: 'Google Play',
  stripe: 'Web billing',
};

const CHANNEL_OPTIONS: readonly { value: Channel; label: string }[] = [
  { value: 'app_store', label: 'App Store (iPhone or iPad)' },
  { value: 'play_store', label: 'Google Play (Android)' },
  { value: 'stripe', label: 'PencilLift web billing' },
];

function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/**
 * Decision: App Store and Google Play offers can only be applied through the store's own offer
 * sheet inside the PencilLift app (RevenueCat/StoreKit/Play Billing), and that in-app step does not
 * exist yet. Reserving a native-channel code here would create a reservation nothing can complete
 * (it would hold a cap slot and block the family's next code), so native codes are previewed but
 * not reserved until the in-app step ships. Web billing (Stripe) redemption stays available; the
 * API reports CHANNEL_UNAVAILABLE while web billing is disabled.
 */
const NATIVE_STORE_STEP_AVAILABLE = false;

function canRedeemOnWeb(channel: Channel): boolean {
  return channel === 'stripe' || NATIVE_STORE_STEP_AVAILABLE;
}

interface QuoteRequest {
  code: string;
  channel: Channel;
  paidSlots?: number;
}

function PromoSection() {
  const headingId = useId();
  const [historyVersion, setHistoryVersion] = useState(0);
  const refreshHistory = useCallback(() => setHistoryVersion((v) => v + 1), []);
  return (
    <>
      <section className="card" style={sectionStyle} aria-labelledby={headingId}>
        <h2 id={headingId}>Monthly promo code</h2>
        <p>
          PencilLift may publish a new code each month. A code covers one monthly billing period
          only. Enter a new code each month for another discounted month — codes never carry
          forward, and without a new code your next renewal is your regular price.
        </p>
        <CodeEntry onRedeemed={refreshHistory} />
      </section>
      <HistorySection version={historyVersion} />
    </>
  );
}

function CodeEntry({ onRedeemed }: { onRedeemed: () => void }) {
  const { api } = useSession();
  const codeId = useId();
  const slotsId = useId();
  const errorId = useId();
  const [code, setCode] = useState('');
  const [channel, setChannel] = useState<Channel | null>(null);
  const [slots, setSlots] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [preview, setPreview] = useState<{
    request: QuoteRequest;
    quote: Quote;
    key: string;
  } | null>(null);
  const [result, setResult] = useState<Redemption | null>(null);

  const check = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = code.trim();
    if (trimmed.length < 8 || trimmed.length > 24) {
      setFieldError('Enter the code exactly as shown, including any dashes.');
      return;
    }
    if (!channel) {
      setFieldError('Choose where your subscription is billed.');
      return;
    }
    setFieldError(null);
    setError(null);
    setPreview(null);
    setResult(null);
    const request: QuoteRequest = {
      code: trimmed,
      channel,
      ...(slots === '' ? {} : { paidSlots: Number(slots) }),
    };
    setChecking(true);
    try {
      const quote = await api.send(
        'POST',
        '/v1/family/promotions/quote',
        request,
        promoQuoteResponseSchema,
      );
      // Decision: one idempotency key per previewed quote, reused for every retry of its redeem, so
      // a double click or a retry after a timeout can never create a second redemption.
      setPreview({ request, quote, key: newIdempotencyKey() });
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <form onSubmit={(e) => void check(e)} noValidate>
        <label htmlFor={codeId}>Promo code</label>
        <input
          id={codeId}
          value={code}
          maxLength={24}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          aria-describedby={fieldError ? errorId : undefined}
          onChange={(e) => {
            setCode(e.target.value);
            setFieldError(null);
          }}
        />
        <fieldset style={{ border: 0, padding: 0, margin: '12px 0 0' }}>
          <legend style={{ fontWeight: 700 }}>Where is your subscription billed?</legend>
          {CHANNEL_OPTIONS.map((option) => (
            <label key={option.value} style={{ fontWeight: 400, display: 'flex', gap: 8 }}>
              <input
                type="radio"
                name="promo-channel"
                value={option.value}
                checked={channel === option.value}
                style={{ width: 'auto', minHeight: 24 }}
                onChange={() => {
                  setChannel(option.value);
                  setFieldError(null);
                }}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
        <label htmlFor={slotsId}>Plan size (only if you haven’t subscribed yet)</label>
        <select id={slotsId} value={slots} onChange={(e) => setSlots(e.target.value)}>
          <option value="">Use my current plan</option>
          {priceTable(DEFAULT_MAX_PAID_SLOTS).map((tier) => (
            <option key={tier.paidSlots} value={String(tier.paidSlots)}>
              {tier.paidSlots} {tier.paidSlots === 1 ? 'child' : 'children'} ·{' '}
              {formatUsd(tier.cents)}/month
            </option>
          ))}
        </select>
        {fieldError ? (
          <p id={errorId} role="alert" style={{ color: 'var(--danger)', margin: '4px 0 0' }}>
            {fieldError}
          </p>
        ) : null}
        <div style={buttonRow}>
          <button type="submit" className="btn" disabled={checking}>
            {checking ? 'Checking…' : 'Check code'}
          </button>
        </div>
      </form>
      {error ? <PromoError error={error} action="Checking or using a promo code" /> : null}
      {preview && !result ? (
        <QuotePreview
          quote={preview.quote}
          request={preview.request}
          idempotencyKey={preview.key}
          onCancel={() => setPreview(null)}
          onRedeemed={(r) => {
            setResult(r);
            setCode('');
            onRedeemed();
          }}
        />
      ) : null}
      {result ? <RedemptionResult redemption={result} /> : null}
    </>
  );
}

function targetPeriodText(quote: Quote): string {
  return quote.targetPeriod.kind === 'first_full_period'
    ? 'Applies to your first full monthly billing period.'
    : `Applies to your renewal starting ${longDate(quote.targetPeriod.periodStart)} (expected date — your store sets the exact date).`;
}

function Amounts({ rows }: { rows: readonly { label: string; value: string }[] }) {
  return (
    <dl
      style={{
        display: 'grid',
        gridTemplateColumns: 'max-content max-content',
        gap: '4px 16px',
        margin: '8px 0',
      }}
    >
      {rows.map((row) => (
        <Row key={row.label} label={row.label}>
          {row.value}
        </Row>
      ))}
    </dl>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt style={{ fontWeight: 700 }}>{label}</dt>
      <dd style={{ margin: 0 }}>{children}</dd>
    </>
  );
}

function QuotePreview({
  quote,
  request,
  idempotencyKey,
  onCancel,
  onRedeemed,
}: {
  quote: Quote;
  request: QuoteRequest;
  idempotencyKey: string;
  onCancel: () => void;
  onRedeemed: (redemption: Redemption) => void;
}) {
  const { api } = useSession();
  const headingId = useId();
  const ackId = useId();
  const ackErrorId = useId();
  const [acknowledged, setAcknowledged] = useState(false);
  const [ackError, setAckError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);

  const redeem = async () => {
    if (!acknowledged) {
      setAckError(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const redemption = await api.send(
        'POST',
        '/v1/family/promotions/redeem',
        { ...request, idempotencyKey },
        promoRedemptionSchema,
      );
      onRedeemed(redemption);
    } catch (e) {
      setError(toApiError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="card"
      style={{ ...sectionStyle, border: '2px solid var(--teal)' }}
      aria-labelledby={headingId}
    >
      <h3 id={headingId}>Your code preview</h3>
      <p style={{ margin: 0 }}>
        <strong>{quote.percentOff}% off</strong> · {monthLabel(quote.campaignMonth)} code
      </p>
      <p>{targetPeriodText(quote)}</p>
      <p>This code covers one monthly billing period only; it never renews itself.</p>
      <Amounts
        rows={[
          { label: 'Regular price', value: formatUsd(quote.regularCents) },
          { label: 'Discount', value: `−${formatUsd(quote.discountCents)}` },
          { label: 'You would pay', value: formatUsd(quote.chargedCents) },
        ]}
      />
      <p>
        <strong>
          Without a new code your next renewal is {formatUsd(quote.nextRegularRenewalCents)}.
        </strong>
      </p>
      <p>Preview — your store shows the final amount.</p>
      <p>
        A discounted month contributes $0 to your school. Full-price months contribute $1 from
        PencilLift.
      </p>
      {canRedeemOnWeb(request.channel) ? (
        <>
          <label style={{ fontWeight: 400, display: 'flex', gap: 8 }} htmlFor={ackId}>
            <input
              id={ackId}
              type="checkbox"
              checked={acknowledged}
              style={{ width: 'auto', minHeight: 24 }}
              aria-describedby={ackError ? ackErrorId : undefined}
              onChange={(e) => {
                setAcknowledged(e.target.checked);
                setAckError(false);
              }}
            />
            I understand this discount applies to one billing period only, and my store confirms the
            final amount.
          </label>
          {ackError ? (
            <p id={ackErrorId} role="alert" style={{ color: 'var(--danger)', margin: '4px 0 0' }}>
              Please confirm you understand the terms above.
            </p>
          ) : null}
          <div style={buttonRow}>
            <button type="button" className="btn" disabled={busy} onClick={() => void redeem()}>
              {busy ? 'Redeeming…' : 'Redeem code'}
            </button>
            <button type="button" className="btn secondary" disabled={busy} onClick={onCancel}>
              Cancel
            </button>
          </div>
          {error ? <PromoError error={error} action="Using a promo code" /> : null}
        </>
      ) : (
        <div className="notice" role="status">
          <p style={{ margin: 0 }}>
            <strong>Not available yet.</strong> {CHANNEL_NAME[request.channel]} codes are redeemed
            inside the PencilLift app, where your store confirms the offer. That in-app store step
            isn’t available yet. No code has been used, and your next renewal stays at the regular
            price.
          </p>
          <div style={buttonRow}>
            <button type="button" className="btn secondary" onClick={onCancel}>
              Close preview
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

const STATE_LABEL: Record<RedemptionState, string> = {
  reserved: 'Reserved – waiting for the store step',
  provider_pending: 'Waiting for the store to confirm',
  confirmed: 'Confirmed by the store',
  rejected: 'Not applied – the store declined it',
  expired: 'Expired – not applied',
  reconciled: 'Used – discounted month completed',
};

/** What the parent should do next, in words (web cannot present a native store offer). */
function nextActionText(redemption: Redemption): string | null {
  const action = redemption.nextAction;
  if (action?.kind === 'present_store_offer') {
    return 'This code needs your store’s offer sheet in the PencilLift app, and that in-app step isn’t available yet. No discount has been applied; unless your store confirms an offer, your next renewal stays at the regular price.';
  }
  if (action?.kind === 'await_provider') {
    return 'Your discount is not final until the store confirms it. We’ll show the result here; your store receipt is the final amount.';
  }
  return null;
}

function RedemptionResult({ redemption }: { redemption: Redemption }) {
  const headingId = useId();
  const next = nextActionText(redemption);
  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId} aria-live="polite">
      <h3 id={headingId}>Redemption status</h3>
      <p>
        <strong>{STATE_LABEL[redemption.state]}</strong> · {redemption.percentOff}% off ·{' '}
        {monthLabel(redemption.campaignMonth)} code
      </p>
      {next ? <p>{next}</p> : null}
    </section>
  );
}

function periodText(redemption: Redemption): string {
  return redemption.targetPeriodStart
    ? `Billing period starting ${longDate(redemption.targetPeriodStart)}`
    : 'Your first full monthly billing period';
}

function HistorySection({ version }: { version: number }) {
  const headingId = useId();
  const query = useApiQuery(
    (api) => api.get('/v1/family/promotions', familyPromotionsResponseSchema),
    [version],
  );
  const data = useLastGood(query);
  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>Your promo history</h2>
      {data === null && query.status === 'loading' ? <Loading label="Loading your codes…" /> : null}
      {query.status === 'error' ? (
        <ErrorState message={query.error.message} onRetry={query.reload} />
      ) : null}
      {data && data.redemptions.length === 0 ? (
        <p>No promo codes used yet. Codes you use appear here with their status.</p>
      ) : null}
      {data && data.redemptions.length > 0 ? (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {data.redemptions.map((r) => {
            const next = nextActionText(r);
            return (
              <li key={r.id} style={{ borderTop: '1px solid #e3e8ee', padding: '12px 0' }}>
                <p style={{ margin: 0, fontWeight: 700 }}>
                  {monthLabel(r.campaignMonth)} code · {r.percentOff}% off
                </p>
                <p style={{ margin: '4px 0' }}>
                  {periodText(r)} · {formatUsd(r.chargedCents)} instead of{' '}
                  {formatUsd(r.regularCents)}
                </p>
                <p style={{ margin: '4px 0' }}>Status: {STATE_LABEL[r.state]}</p>
                {next ? <p style={{ margin: '4px 0', color: 'var(--muted)' }}>{next}</p> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <p style={{ color: 'var(--muted)' }}>
        Amounts are what PencilLift previewed; your store receipt shows the final amount.
      </p>
    </section>
  );
}
