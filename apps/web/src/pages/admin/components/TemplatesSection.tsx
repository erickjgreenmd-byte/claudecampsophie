import { useId, useState } from 'react';
import type { z } from 'zod';
import {
  activationResultSchema,
  promoTemplateSchema,
  type schoolAdminSchema,
} from '@pencillift/contracts';
import { formatUsd } from '@pencillift/domain';
import { useSession } from '../../../lib/session.tsx';
import {
  AdminFeedback,
  buttonRow,
  ConfirmButton,
  sectionStyle,
  useAdminAction,
} from './admin-ui.tsx';
import { TemplateForm } from './TemplateForm.tsx';
import {
  ACTIVATION_PROBLEM_TEXT,
  CHANNEL_LABEL,
  emptyTemplateForm,
  SUBSCRIBER_LABEL,
  templateToForm,
  type PromoTemplate,
  type PromoTemplateInput,
} from './template-form.ts';

type AdminSchool = z.infer<typeof schoolAdminSchema>;

function templateStatus(t: PromoTemplate): string {
  if (!t.enabled) return 'Draft – not generating';
  return t.paused ? 'Enabled – paused, not generating' : 'Enabled – generates each month';
}

function windowText(t: PromoTemplate): string {
  const end = t.windowEndDay === 'end_of_month' ? 'the end of the month' : `day ${t.windowEndDay}`;
  return `Day ${t.windowStartDay} through ${end}`;
}

/** Template list with create/edit, activation (with problems) and pause/resume. */
export function TemplatesSection({
  templates,
  schools,
  onChanged,
}: {
  templates: readonly PromoTemplate[];
  schools: readonly AdminSchool[];
  onChanged: () => void;
}) {
  const { api } = useSession();
  const headingId = useId();
  const [editing, setEditing] = useState<'new' | PromoTemplate | null>(null);
  const { feedback, run } = useAdminAction();
  const schoolName = new Map(schools.map((s) => [s.id, s.name]));

  const save = async (input: PromoTemplateInput): Promise<boolean> => {
    const target = editing;
    const ok = await run('save', async () => {
      if (target === 'new' || target === null) {
        await api.send('POST', '/v1/admin/promo-templates', input, promoTemplateSchema);
        return 'Template saved as a draft. Activate it when it is ready to generate monthly campaigns.';
      }
      const saved = await api.send(
        'PATCH',
        `/v1/admin/promo-templates/${target.id}`,
        input,
        promoTemplateSchema,
      );
      return saved.enabled || !target.enabled
        ? 'Template updated.'
        : 'Template updated. It no longer passes activation checks, so it was switched back to a draft.';
    });
    if (ok) {
      setEditing(null);
      onChanged();
    }
    return ok;
  };

  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>Campaign templates</h2>
      <p>
        Each enabled template generates one campaign per calendar month in its own timezone. The
        discount is exactly the template’s percentage, never chosen at random, and every campaign
        has a redemption cap and a budget cap.
      </p>
      <AdminFeedback feedback={feedback} />
      {templates.length === 0 ? (
        <p>No templates yet. Create one to start monthly promotions.</p>
      ) : null}
      {templates.map((t) => (
        <TemplateCard
          key={t.id}
          template={t}
          schoolName={t.schoolId ? (schoolName.get(t.schoolId) ?? `School ${t.schoolId}`) : null}
          onEdit={() => setEditing(t)}
          onChanged={onChanged}
        />
      ))}
      {editing === null ? (
        <div style={buttonRow}>
          <button type="button" className="btn" onClick={() => setEditing('new')}>
            New template
          </button>
        </div>
      ) : (
        <TemplateForm
          key={editing === 'new' ? 'new' : editing.id}
          title={editing === 'new' ? 'New template' : `Edit ${editing.name}`}
          initial={editing === 'new' ? emptyTemplateForm() : templateToForm(editing)}
          schools={schools}
          submitLabel={editing === 'new' ? 'Create template' : 'Save changes'}
          onSubmit={save}
          onCancel={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function TemplateCard({
  template: t,
  schoolName,
  onEdit,
  onChanged,
}: {
  template: PromoTemplate;
  schoolName: string | null;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const { api } = useSession();
  const titleId = useId();
  const { busy, feedback, run } = useAdminAction();
  const [problems, setProblems] = useState<string[] | null>(null);

  const activate = () =>
    run('activate', async () => {
      const result = await api.send(
        'POST',
        `/v1/admin/promo-templates/${t.id}/activate`,
        undefined,
        activationResultSchema,
      );
      if (!result.ok) {
        // Shown as the problems list below (an alert), not as a success message.
        setProblems(result.problems);
        return '';
      }
      setProblems(null);
      onChanged();
      return 'Activated. This template now generates a campaign each month.';
    });

  const setPaused = (paused: boolean) =>
    run('pause', async () => {
      await api.send('PATCH', `/v1/admin/promo-templates/${t.id}`, { paused }, promoTemplateSchema);
      onChanged();
      return paused ? 'Template paused.' : 'Template resumed.';
    });

  return (
    <article
      aria-labelledby={titleId}
      style={{ borderTop: '1px solid #e3e8ee', padding: '12px 0' }}
    >
      <h3 id={titleId} style={{ margin: '0 0 4px' }}>
        {t.name}
      </h3>
      <p style={{ margin: 0 }}>
        <strong>Status:</strong> {templateStatus(t)}
      </p>
      <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '2px 12px' }}>
        <dt>Discount</dt>
        <dd style={{ margin: 0 }}>{t.percentOff}% off one monthly billing period</dd>
        <dt>Audience</dt>
        <dd style={{ margin: 0 }}>{schoolName ?? 'Any eligible family'}</dd>
        <dt>Plan sizes</dt>
        <dd style={{ margin: 0 }}>{t.eligibleTiers.join(', ')}</dd>
        <dt>Who can redeem</dt>
        <dd style={{ margin: 0 }}>
          {t.subscriberEligibility.map((c) => SUBSCRIBER_LABEL[c]).join(', ')}
        </dd>
        <dt>Redemption cap</dt>
        <dd style={{ margin: 0 }}>{t.redemptionCap.toLocaleString('en-US')} redemptions</dd>
        <dt>Budget cap</dt>
        <dd style={{ margin: 0 }}>{formatUsd(t.budgetCapCents)}</dd>
        <dt>Calendar</dt>
        <dd style={{ margin: 0 }}>
          {t.calendarTimezone} ({t.timezoneConfirmed ? 'confirmed' : 'not confirmed'})
        </dd>
        <dt>Window</dt>
        <dd style={{ margin: 0 }}>{windowText(t)}</dd>
        <dt>Codes</dt>
        <dd style={{ margin: 0 }}>
          {t.codeMode === 'shared'
            ? `One shared code${t.sharedCodeUsageCap ? `, up to ${t.sharedCodeUsageCap.toLocaleString('en-US')} uses` : ''}`
            : `${(t.individualCodeCount ?? 0).toLocaleString('en-US')} individual codes`}
        </dd>
        <dt>Channels</dt>
        <dd style={{ margin: 0 }}>{t.channels.map((c) => CHANNEL_LABEL[c]).join(', ')}</dd>
      </dl>
      <div style={buttonRow}>
        <button type="button" className="btn secondary" disabled={busy !== null} onClick={onEdit}>
          Edit
        </button>
        {!t.enabled ? (
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            aria-label={`Activate ${t.name}`}
            onClick={() => void activate()}
          >
            {busy === 'activate' ? 'Checking…' : 'Activate'}
          </button>
        ) : t.paused ? (
          <button
            type="button"
            className="btn"
            disabled={busy !== null}
            onClick={() => void setPaused(false)}
          >
            Resume template
          </button>
        ) : (
          <ConfirmButton
            label="Pause template"
            secondary
            disabled={busy !== null}
            prompt={`Pause ${t.name}? No new monthly campaigns are generated while it is paused. Existing campaigns are not changed.`}
            confirmLabel="Yes, pause template"
            onConfirm={() => setPaused(true)}
          />
        )}
      </div>
      <AdminFeedback feedback={feedback} />
      {problems && problems.length > 0 ? (
        <div className="error" role="alert">
          <p style={{ margin: 0 }}>
            <strong>Not activated.</strong> Fix these problems, then try again:
          </p>
          <ul aria-label="Activation problems">
            {problems.map((p) => (
              <li key={p}>{ACTIVATION_PROBLEM_TEXT[p] ?? p}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </article>
  );
}
