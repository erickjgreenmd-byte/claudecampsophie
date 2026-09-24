import { useId, useState, type FormEvent, type ReactNode } from 'react';
import type { z } from 'zod';
import type { schoolAdminSchema } from '@pencillift/contracts';
import { formatUsd, monthlyPriceCents } from '@pencillift/domain';
import { discountedCents, applePricePointProblem } from './admin-money.ts';
import { buttonRow, FieldError } from './admin-ui.tsx';
import {
  CHANNEL_LABEL,
  SUBSCRIBER_LABEL,
  TIERS,
  validateTemplateForm,
  type Channel,
  type PromoTemplateInput,
  type SubscriberClass,
  type TemplateErrors,
  type TemplateField,
  type TemplateFormValues,
} from './template-form.ts';

type AdminSchool = z.infer<typeof schoolAdminSchema>;

const checkboxStyle = { width: 'auto', minHeight: 24 } as const;
const inlineLabel = { fontWeight: 400, display: 'flex', gap: 8, alignItems: 'center' } as const;
const fieldsetStyle = { border: 0, padding: 0, margin: '12px 0 0' } as const;

function toggle<T>(list: readonly T[], value: T, on: boolean): T[] {
  return on ? [...list.filter((v) => v !== value), value] : list.filter((v) => v !== value);
}

/**
 * Create/edit form for a monthly promo template. Client-side validation mirrors the contract
 * ranges; the calendar timezone is always visible next to its confirmation checkbox.
 */
export function TemplateForm({
  title,
  initial,
  schools,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  title: string;
  initial: TemplateFormValues;
  schools: readonly AdminSchool[];
  submitLabel: string;
  onSubmit: (input: PromoTemplateInput) => Promise<boolean>;
  onCancel: () => void;
}) {
  const formId = useId();
  const [values, setValues] = useState<TemplateFormValues>(initial);
  const [errors, setErrors] = useState<TemplateErrors>({});
  const [saving, setSaving] = useState(false);

  const set = <K extends TemplateField>(key: K, value: TemplateFormValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const result = validateTemplateForm(values);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      await onSubmit(result.input);
    } finally {
      setSaving(false);
    }
  };

  const id = (field: TemplateField) => `${formId}-${field}`;
  const errId = (field: TemplateField) => `${formId}-${field}-error`;
  const described = (field: TemplateField) => (errors[field] ? errId(field) : undefined);
  const zone = values.calendarTimezone.trim() || '(no timezone)';
  const percent = Number(values.percentOff);
  const percentValid = Number.isInteger(percent) && percent >= 5 && percent <= 100;
  // Keep the school of an existing template selectable even if the school list failed to load.
  const knownSchool = values.schoolId === '' || schools.some((s) => s.id === values.schoolId);

  return (
    <form
      className="card"
      aria-labelledby={`${formId}-title`}
      onSubmit={(e) => void submit(e)}
      noValidate
      style={{ marginTop: 16, border: '2px solid var(--teal)' }}
    >
      <h3 id={`${formId}-title`}>{title}</h3>

      <label htmlFor={id('name')}>Template name</label>
      <input
        id={id('name')}
        value={values.name}
        maxLength={120}
        aria-describedby={described('name')}
        onChange={(e) => set('name', e.target.value)}
      />
      <FieldError id={errId('name')} message={errors.name} />

      <label htmlFor={id('schoolId')}>School audience (optional)</label>
      <select
        id={id('schoolId')}
        value={values.schoolId}
        onChange={(e) => set('schoolId', e.target.value)}
      >
        <option value="">No school audience – any eligible family</option>
        {schools.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
        {knownSchool ? null : <option value={values.schoolId}>School {values.schoolId}</option>}
      </select>

      <label htmlFor={id('percentOff')}>Discount percent (5–100)</label>
      <input
        id={id('percentOff')}
        inputMode="numeric"
        value={values.percentOff}
        aria-describedby={described('percentOff')}
        onChange={(e) => set('percentOff', e.target.value)}
      />
      <FieldError id={errId('percentOff')} message={errors.percentOff} />

      <CheckboxGroup
        legend="Eligible plan sizes"
        error={errors.eligibleTiers}
        errorId={errId('eligibleTiers')}
      >
        {TIERS.map((tier) => (
          <label key={tier} style={inlineLabel}>
            <input
              type="checkbox"
              style={checkboxStyle}
              checked={values.eligibleTiers.includes(tier)}
              onChange={(e) =>
                set('eligibleTiers', toggle(values.eligibleTiers, tier, e.target.checked))
              }
            />
            {tier} {tier === 1 ? 'child' : 'children'} ({formatUsd(monthlyPriceCents(tier))}/month)
          </label>
        ))}
      </CheckboxGroup>
      {percentValid && values.eligibleTiers.length > 0 ? (
        <DiscountPreview
          percent={percent}
          tiers={values.eligibleTiers}
          channels={values.channels}
        />
      ) : null}

      <CheckboxGroup
        legend="Who can redeem"
        error={errors.subscriberEligibility}
        errorId={errId('subscriberEligibility')}
      >
        {(['new', 'existing', 'lapsed'] as const).map((c: SubscriberClass) => (
          <label key={c} style={inlineLabel}>
            <input
              type="checkbox"
              style={checkboxStyle}
              checked={values.subscriberEligibility.includes(c)}
              onChange={(e) =>
                set(
                  'subscriberEligibility',
                  toggle(values.subscriberEligibility, c, e.target.checked),
                )
              }
            />
            {SUBSCRIBER_LABEL[c]}
          </label>
        ))}
      </CheckboxGroup>

      <label htmlFor={id('redemptionCap')}>Redemption cap per month (families)</label>
      <input
        id={id('redemptionCap')}
        inputMode="numeric"
        value={values.redemptionCap}
        aria-describedby={described('redemptionCap')}
        onChange={(e) => set('redemptionCap', e.target.value)}
      />
      <FieldError id={errId('redemptionCap')} message={errors.redemptionCap} />

      <label htmlFor={id('budgetDollars')}>Budget cap per month (USD discount)</label>
      <input
        id={id('budgetDollars')}
        inputMode="decimal"
        value={values.budgetDollars}
        aria-describedby={described('budgetDollars')}
        onChange={(e) => set('budgetDollars', e.target.value)}
      />
      <FieldError id={errId('budgetDollars')} message={errors.budgetDollars} />

      <label htmlFor={id('calendarTimezone')}>Calendar timezone (IANA, e.g. UTC)</label>
      <input
        id={id('calendarTimezone')}
        value={values.calendarTimezone}
        maxLength={64}
        aria-describedby={described('calendarTimezone')}
        onChange={(e) => {
          // Decision: any change to the zone clears the confirmation, so the owner always confirms
          // the zone that is actually saved (the API applies the same rule on update).
          setValues((v) => ({ ...v, calendarTimezone: e.target.value, timezoneConfirmed: false }));
          setErrors((er) => ({ ...er, calendarTimezone: undefined }));
        }}
      />
      <FieldError id={errId('calendarTimezone')} message={errors.calendarTimezone} />
      <label style={inlineLabel}>
        <input
          type="checkbox"
          style={checkboxStyle}
          checked={values.timezoneConfirmed}
          onChange={(e) => set('timezoneConfirmed', e.target.checked)}
        />
        I confirm campaign months follow {zone} time.
      </label>
      {!values.timezoneConfirmed ? (
        <p style={{ margin: '4px 0 0', color: 'var(--muted)' }}>
          You can save a draft without confirming, but it can’t be activated until you do.
        </p>
      ) : null}

      <fieldset style={fieldsetStyle}>
        <legend style={{ fontWeight: 700 }}>Redemption window in each campaign month</legend>
        <label htmlFor={id('windowStartDay')}>Opens on day (1–28)</label>
        <input
          id={id('windowStartDay')}
          inputMode="numeric"
          value={values.windowStartDay}
          aria-describedby={described('windowStartDay')}
          onChange={(e) => set('windowStartDay', e.target.value)}
        />
        <FieldError id={errId('windowStartDay')} message={errors.windowStartDay} />
        <label htmlFor={id('windowEndDay')}>Closes after day</label>
        <select
          id={id('windowEndDay')}
          value={values.windowEndDay}
          aria-describedby={described('windowEndDay')}
          onChange={(e) => set('windowEndDay', e.target.value)}
        >
          <option value="end_of_month">End of the month</option>
          {Array.from({ length: 31 }, (_, i) => String(i + 1)).map((day) => (
            <option key={day} value={day}>
              Day {day}
            </option>
          ))}
        </select>
        <FieldError id={errId('windowEndDay')} message={errors.windowEndDay} />
      </fieldset>

      <fieldset style={fieldsetStyle}>
        <legend style={{ fontWeight: 700 }}>Codes</legend>
        {(['shared', 'individual'] as const).map((mode) => (
          <label key={mode} style={inlineLabel}>
            <input
              type="radio"
              name={`${formId}-codeMode`}
              style={checkboxStyle}
              checked={values.codeMode === mode}
              onChange={() => set('codeMode', mode)}
            />
            {mode === 'shared' ? 'One shared code for the audience' : 'Individual single-use codes'}
          </label>
        ))}
        {values.codeMode === 'individual' ? (
          <>
            <label htmlFor={id('individualCodeCount')}>Individual codes per month</label>
            <input
              id={id('individualCodeCount')}
              inputMode="numeric"
              value={values.individualCodeCount}
              aria-describedby={described('individualCodeCount')}
              onChange={(e) => set('individualCodeCount', e.target.value)}
            />
            <FieldError id={errId('individualCodeCount')} message={errors.individualCodeCount} />
          </>
        ) : (
          <>
            <label htmlFor={id('sharedCodeUsageCap')}>Shared code usage cap (optional)</label>
            <input
              id={id('sharedCodeUsageCap')}
              inputMode="numeric"
              value={values.sharedCodeUsageCap}
              aria-describedby={described('sharedCodeUsageCap')}
              onChange={(e) => set('sharedCodeUsageCap', e.target.value)}
            />
            <FieldError id={errId('sharedCodeUsageCap')} message={errors.sharedCodeUsageCap} />
            <p style={{ margin: '4px 0 0', color: 'var(--muted)' }}>
              The code usage cap limits uses of the code; each family can still redeem only once per
              campaign, and the campaign cap always applies.
            </p>
          </>
        )}
      </fieldset>

      <CheckboxGroup legend="Billing channels" error={errors.channels} errorId={errId('channels')}>
        {(['app_store', 'play_store', 'stripe'] as const).map((channel: Channel) => (
          <label key={channel} style={inlineLabel}>
            <input
              type="checkbox"
              style={checkboxStyle}
              checked={values.channels.includes(channel)}
              onChange={(e) => set('channels', toggle(values.channels, channel, e.target.checked))}
            />
            {CHANNEL_LABEL[channel]}
          </label>
        ))}
      </CheckboxGroup>

      <div style={buttonRow}>
        <button type="submit" className="btn" disabled={saving}>
          {saving ? 'Saving…' : submitLabel}
        </button>
        <button type="button" className="btn secondary" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function CheckboxGroup({
  legend,
  error,
  errorId,
  children,
}: {
  legend: string;
  error: string | undefined;
  errorId: string;
  children: ReactNode;
}) {
  return (
    <fieldset style={fieldsetStyle} aria-describedby={error ? errorId : undefined}>
      <legend style={{ fontWeight: 700 }}>{legend}</legend>
      {children}
      <FieldError id={errorId} message={error} />
    </fieldset>
  );
}

/** What the discount means per plan size, and where the App Store cannot represent it exactly. */
function DiscountPreview({
  percent,
  tiers,
  channels,
}: {
  percent: number;
  tiers: readonly number[];
  channels: readonly Channel[];
}) {
  const sorted = [...tiers].sort((a, b) => a - b);
  return (
    <div className="notice" style={{ marginTop: 8 }}>
      <p style={{ margin: 0, fontWeight: 700 }}>Preview for one discounted billing period</p>
      <ul style={{ margin: '4px 0 0' }}>
        {sorted.map((tier) => {
          const regular = monthlyPriceCents(tier);
          const apple = channels.includes('app_store')
            ? applePricePointProblem(tier, percent)
            : null;
          return (
            <li key={tier}>
              {tier} {tier === 1 ? 'child' : 'children'}: {formatUsd(regular)} →{' '}
              {formatUsd(discountedCents(regular, percent))}
              {apple ? ` · App Store: ${apple}` : ''}
            </li>
          );
        })}
      </ul>
      <p style={{ margin: '4px 0 0' }}>
        A discounted period earns its school $0. Without a new code, the next period is the regular
        price.
      </p>
    </div>
  );
}
