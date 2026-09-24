import { useId, useState, type FormEvent } from 'react';
import { useSession } from '../../../lib/session.tsx';
import {
  adminOkResponseSchema,
  AdminFeedback,
  buttonRow,
  FieldError,
  useAdminAction,
} from './admin-ui.tsx';
import {
  cellLabel,
  MAPPING_STATUS_LABEL,
  unsupportedReason,
  validateMapping,
  type CampaignMapping,
  type MappingErrors,
  type MappingFormValues,
  type MappingStatus,
} from './offer-mapping.ts';
import type { Channel } from './template-form.ts';

const STATUSES: readonly MappingStatus[] = ['pending', 'ready', 'failed', 'unsupported'];

/**
 * Edits one campaign × channel × tier provider offer mapping. When the store cannot represent the
 * exact discount (e.g. an App Store amount that is not a price point) "Ready" is unavailable and
 * the mapping must be recorded as unsupported with a reason; nothing is rounded silently.
 */
export function OfferMappingEditor({
  campaignId,
  percentOff,
  channel,
  paidSlots,
  current,
  onSaved,
  onCancel,
}: {
  campaignId: string;
  percentOff: number;
  channel: Channel;
  paidSlots: number;
  current: CampaignMapping | undefined;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { api } = useSession();
  const formId = useId();
  const blocked = unsupportedReason(channel, paidSlots, percentOff);
  const [values, setValues] = useState<MappingFormValues>({
    status: current?.status ?? (blocked ? 'unsupported' : 'pending'),
    providerOfferId: current?.providerOfferId ?? '',
    reason: current?.reason ?? '',
  });
  const [errors, setErrors] = useState<MappingErrors>({});
  const { busy, feedback, run } = useAdminAction();
  const label = cellLabel(channel, paidSlots);

  const set = <K extends keyof MappingFormValues>(key: K, value: MappingFormValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const result = validateMapping(channel, paidSlots, percentOff, values);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    const ok = await run('save', async () => {
      await api.send(
        'PUT',
        `/v1/admin/campaigns/${campaignId}/offer-mappings`,
        result.input,
        adminOkResponseSchema,
      );
      return `Saved the ${label} mapping.`;
    });
    if (ok) onSaved();
  };

  const err = (field: keyof MappingFormValues) => `${formId}-${field}-error`;
  return (
    <form
      aria-label={`Offer mapping: ${label}`}
      onSubmit={(e) => void submit(e)}
      noValidate
      className="card"
      style={{ border: '2px solid var(--teal)', marginTop: 8 }}
    >
      <h4 style={{ margin: 0 }}>Offer mapping: {label}</h4>
      {blocked ? (
        <p className="notice" style={{ marginTop: 8 }}>
          {blocked} Record it as unsupported with the reason, and raise the smallest compliant
          alternative with the owner.
        </p>
      ) : null}
      <label htmlFor={`${formId}-status`}>Status</label>
      <select
        id={`${formId}-status`}
        value={values.status}
        aria-describedby={errors.status ? err('status') : undefined}
        onChange={(e) => set('status', e.target.value as MappingStatus)}
      >
        {STATUSES.map((s) => (
          <option key={s} value={s} disabled={s === 'ready' && blocked !== null}>
            {MAPPING_STATUS_LABEL[s]}
            {s === 'ready' && blocked ? ' (not available for this amount)' : ''}
          </option>
        ))}
      </select>
      <FieldError id={err('status')} message={errors.status} />
      <label htmlFor={`${formId}-offer`}>Provider offer id</label>
      <input
        id={`${formId}-offer`}
        value={values.providerOfferId}
        maxLength={200}
        autoComplete="off"
        aria-describedby={errors.providerOfferId ? err('providerOfferId') : undefined}
        onChange={(e) => set('providerOfferId', e.target.value)}
      />
      <FieldError id={err('providerOfferId')} message={errors.providerOfferId} />
      <label htmlFor={`${formId}-reason`}>Reason (required for failed or unsupported)</label>
      <input
        id={`${formId}-reason`}
        value={values.reason}
        maxLength={300}
        aria-describedby={errors.reason ? err('reason') : undefined}
        onChange={(e) => set('reason', e.target.value)}
      />
      <FieldError id={err('reason')} message={errors.reason} />
      <div style={buttonRow}>
        {blocked && values.reason.trim() === '' ? (
          <button type="button" className="btn secondary" onClick={() => set('reason', blocked)}>
            Use suggested reason
          </button>
        ) : null}
        <button type="submit" className="btn" disabled={busy !== null}>
          {busy ? 'Saving…' : 'Save mapping'}
        </button>
        <button type="button" className="btn secondary" disabled={busy !== null} onClick={onCancel}>
          Cancel
        </button>
      </div>
      <AdminFeedback feedback={feedback} />
    </form>
  );
}
