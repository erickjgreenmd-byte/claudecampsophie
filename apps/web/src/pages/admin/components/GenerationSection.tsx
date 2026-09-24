import { useId, useState } from 'react';
import type { z } from 'zod';
import {
  generationPreviewResponseSchema,
  generationRunResponseSchema,
} from '@pencillift/contracts';
import { ErrorState, Loading } from '../../../components/states.tsx';
import { useApiQuery, useSession } from '../../../lib/session.tsx';
import {
  adminErrorMessage,
  cellStyle,
  ConfirmButton,
  formatUtc,
  monthLabel,
  sectionStyle,
  TableScroll,
  tableStyle,
  toApiError,
} from './admin-ui.tsx';

type RunResult = z.infer<typeof generationRunResponseSchema>;

/**
 * Monthly generation preview and run (spec P17: "administrator preview, generation history,
 * retry"). The API generation is idempotent per template/month, so running again only fills gaps.
 */
export function GenerationSection({
  month,
  version,
  onGenerated,
}: {
  month: string;
  version: number;
  onGenerated: () => void;
}) {
  const { api } = useSession();
  const headingId = useId();
  const query = useApiQuery(
    (a) =>
      a.get(
        `/v1/admin/promo-generation/preview?month=${encodeURIComponent(month)}`,
        generationPreviewResponseSchema,
      ),
    [month, version],
  );
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    setError(null);
    setResult(null);
    try {
      const run = await api.send(
        'POST',
        '/v1/admin/promo-generation/run',
        { month },
        generationRunResponseSchema,
      );
      setResult(run);
      onGenerated();
    } catch (e) {
      setError(adminErrorMessage(toApiError(e)));
    }
  };

  const items = query.status === 'ready' ? query.data.items : [];
  const pending = items.filter((i) => !i.alreadyGenerated).length;

  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>Monthly generation</h2>
      <p>
        Preview which templates generate a campaign for {monthLabel(month)}. Times are shown in UTC;
        each window follows its template’s calendar timezone. Codes are not usable until a store
        mapping is ready.
      </p>
      {query.status === 'loading' ? <Loading label="Loading preview…" /> : null}
      {query.status === 'error' ? (
        <ErrorState message={adminErrorMessage(query.error)} onRetry={query.reload} />
      ) : null}
      {query.status === 'ready' && items.length === 0 ? (
        <p>
          No enabled templates generate a campaign for {monthLabel(month)}. Activate a template
          first.
        </p>
      ) : null}
      {items.length > 0 ? (
        <TableScroll label="Generation preview table">
          <table style={tableStyle} aria-label={`Generation preview for ${monthLabel(month)}`}>
            <thead>
              <tr>
                <th style={cellStyle}>Template</th>
                <th style={cellStyle}>Discount</th>
                <th style={cellStyle}>Opens</th>
                <th style={cellStyle}>Closes</th>
                <th style={cellStyle}>Codes</th>
                <th style={cellStyle}>Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.generationKey}>
                  <td style={cellStyle}>{item.templateName}</td>
                  <td style={cellStyle}>{item.percentOff}%</td>
                  <td style={cellStyle}>{formatUtc(item.opensAt)}</td>
                  <td style={cellStyle}>{formatUtc(item.closesAt)}</td>
                  <td style={cellStyle}>{item.codeCount.toLocaleString('en-US')}</td>
                  <td style={cellStyle}>
                    {item.alreadyGenerated ? 'Already generated' : 'Will be generated'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      ) : null}
      {query.status === 'ready' && pending > 0 ? (
        <ConfirmButton
          label={`Generate ${monthLabel(month)}`}
          prompt={`Generate ${pending} campaign${pending === 1 ? '' : 's'} for ${monthLabel(month)} now? Running again is safe: templates already generated for this month are skipped.`}
          confirmLabel="Yes, generate"
          onConfirm={generate}
        />
      ) : null}
      {query.status === 'ready' && items.length > 0 && pending === 0 ? (
        <p>Every enabled template is already generated for {monthLabel(month)}.</p>
      ) : null}
      {result ? (
        <p role="status" style={{ color: 'var(--success)', fontWeight: 700 }}>
          Created {result.created.length} campaign{result.created.length === 1 ? '' : 's'} for{' '}
          {monthLabel(result.month)}
          {result.skippedExisting.length > 0
            ? `; ${result.skippedExisting.length} already existed and were skipped`
            : ''}
          . New campaigns start in provisioning until a store mapping is ready.
        </p>
      ) : null}
      {error ? <ErrorState message={error} /> : null}
    </section>
  );
}
