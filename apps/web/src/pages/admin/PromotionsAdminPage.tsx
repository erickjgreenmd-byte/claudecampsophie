import { useCallback, useId, useMemo, useState } from 'react';
import {
  listAdminSchoolsResponseSchema,
  listPromoTemplatesResponseSchema,
} from '@pencillift/contracts';
import { ErrorState, Loading } from '../../components/states.tsx';
import { useApiQuery } from '../../lib/session.tsx';
import {
  AdminAccessDenied,
  adminErrorMessage,
  AdminPage,
  isAccessDenied,
  MONTH_RE,
  sectionStyle,
  useLastGood,
  utcMonthOf,
} from './components/admin-ui.tsx';
import { CampaignsSection } from './components/CampaignsSection.tsx';
import { GenerationSection } from './components/GenerationSection.tsx';
import { TemplatesSection } from './components/TemplatesSection.tsx';

/**
 * Owner console for P17 monthly promotions (spec P17 administration; AC_PROMO_13/14, AC_UX_02):
 * templates with validated caps and a visible calendar timezone, generation preview and run,
 * campaign caps/budget usage and status actions, per-channel × tier store offer mappings, and codes.
 * The API requires an owner-admin MFA session for every call.
 */
export default function PromotionsAdminPage() {
  return (
    <AdminPage title="Promotions">
      <PromotionsConsole />
    </AdminPage>
  );
}

function PromotionsConsole() {
  const [templatesVersion, setTemplatesVersion] = useState(0);
  const templates = useApiQuery(
    (api) => api.get('/v1/admin/promo-templates', listPromoTemplatesResponseSchema),
    [templatesVersion],
  );
  const schools = useApiQuery(
    (api) => api.get('/v1/admin/schools', listAdminSchoolsResponseSchema),
    [],
  );
  // Keep the last good list on screen while a refresh is in flight (forms stay mounted).
  const list = useLastGood(templates)?.templates ?? null;

  // Decision: the month picker defaults to the current UTC calendar month; each campaign's own
  // window still follows its template's (visible) timezone.
  const [month, setMonth] = useState(() => utcMonthOf(new Date()));
  const [monthText, setMonthText] = useState(month);
  const [generated, setGenerated] = useState(0);
  const monthId = useId();

  const schoolList = useMemo(
    () => (schools.status === 'ready' ? schools.data.schools : []),
    [schools],
  );
  const templateNames = useMemo(() => new Map((list ?? []).map((t) => [t.id, t.name])), [list]);
  const schoolNames = useMemo(() => new Map(schoolList.map((s) => [s.id, s.name])), [schoolList]);
  const refreshTemplates = useCallback(() => setTemplatesVersion((v) => v + 1), []);

  if (templates.status === 'error' && isAccessDenied(templates.error)) return <AdminAccessDenied />;
  if (list === null) {
    return templates.status === 'error' ? (
      <ErrorState message={adminErrorMessage(templates.error)} onRetry={templates.reload} />
    ) : (
      <Loading label="Loading promotions…" />
    );
  }

  return (
    <>
      <p>
        Discounts from 5% to 100% cover exactly one monthly billing period. Families enter a fresh
        code each month; nothing carries forward, and any discounted period earns its school $0.
        Amounts shown here are previews; store-reported amounts are authoritative.
      </p>
      {templates.status === 'error' ? (
        <ErrorState message={adminErrorMessage(templates.error)} onRetry={templates.reload} />
      ) : null}
      {schools.status === 'error' && !isAccessDenied(schools.error) ? (
        <ErrorState
          message={`School names couldn’t be loaded, so school audiences show their id. ${schools.error.message}`}
          onRetry={schools.reload}
        />
      ) : null}
      <TemplatesSection templates={list} schools={schoolList} onChanged={refreshTemplates} />
      <div className="card" style={sectionStyle}>
        <label htmlFor={monthId}>Campaign month</label>
        <input
          id={monthId}
          type="month"
          value={monthText}
          onChange={(e) => {
            setMonthText(e.target.value);
            if (MONTH_RE.test(e.target.value)) setMonth(e.target.value);
          }}
        />
        {!MONTH_RE.test(monthText) ? (
          <p role="alert" style={{ color: 'var(--danger)', margin: '4px 0 0' }}>
            Enter a month as YYYY-MM.
          </p>
        ) : null}
      </div>
      <GenerationSection
        month={month}
        version={generated}
        onGenerated={() => setGenerated((v) => v + 1)}
      />
      <CampaignsSection
        month={month}
        version={generated}
        templateNames={templateNames}
        schoolNames={schoolNames}
      />
    </>
  );
}
