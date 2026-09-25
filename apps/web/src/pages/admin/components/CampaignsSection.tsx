import { useId, useState } from 'react';
import type { z } from 'zod';
import {
  campaignCodesResponseSchema,
  channelSchema,
  listCampaignsResponseSchema,
  type campaignStatusSchema,
} from '@pencillift/contracts';
import { formatUsd } from '@pencillift/domain';
import { ErrorState, Loading } from '../../../components/states.tsx';
import { useApiQuery, useSession } from '../../../lib/session.tsx';
import {
  adminErrorMessage,
  adminOkResponseSchema,
  AdminFeedback,
  buttonRow,
  cellStyle,
  ConfirmButton,
  formatUtc,
  monthLabel,
  sectionStyle,
  TableScroll,
  tableStyle,
  useAdminAction,
} from './admin-ui.tsx';
import { OfferMappingEditor } from './OfferMappingEditor.tsx';
import {
  campaignRedeemability,
  cellLabel,
  mappingCellStatus,
  tierLabel,
  unsupportedReason,
  type Campaign,
} from './offer-mapping.ts';
import { CHANNEL_LABEL, TIERS, type Channel } from './template-form.ts';

type CampaignStatus = z.infer<typeof campaignStatusSchema>;

const STATUS_LABEL: Record<CampaignStatus, string> = {
  provisioning: 'Provisioning – waiting for a ready store mapping',
  active: 'Active',
  paused: 'Paused – no new redemptions',
  revoked: 'Revoked – codes no longer valid',
  ended: 'Ended',
  failed: 'Failed provisioning',
};

/** R2C-WEB-2: every billing channel from the contract (Amazon Appstore included), as admin-ui's CHANNELS. */
const CHANNELS: readonly Channel[] = channelSchema.options;

type CampaignAction = 'pause' | 'resume' | 'revoke';

/** Campaigns of one month with cap/budget usage, status actions, offer mappings and codes. */
export function CampaignsSection({
  month,
  version,
  templateNames,
  schoolNames,
}: {
  month: string;
  version: number;
  templateNames: ReadonlyMap<string, string>;
  schoolNames: ReadonlyMap<string, string>;
}) {
  const headingId = useId();
  const [changes, setChanges] = useState(0);
  const query = useApiQuery(
    (api) =>
      api.get(
        `/v1/admin/campaigns?month=${encodeURIComponent(month)}`,
        listCampaignsResponseSchema,
      ),
    [month, version, changes],
  );
  const refresh = () => setChanges((v) => v + 1);

  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>Campaigns for {monthLabel(month)}</h2>
      {query.status === 'loading' ? <Loading label="Loading campaigns…" /> : null}
      {query.status === 'error' ? (
        <ErrorState message={adminErrorMessage(query.error)} onRetry={query.reload} />
      ) : null}
      {query.status === 'ready' && query.data.campaigns.length === 0 ? (
        <p>No campaigns for {monthLabel(month)} yet. Preview and generate them above.</p>
      ) : null}
      {query.status === 'ready'
        ? query.data.campaigns.map((c) => (
            <CampaignCard
              key={c.id}
              campaign={c}
              templateName={templateNames.get(c.templateId) ?? 'Template'}
              schoolName={
                c.schoolId ? (schoolNames.get(c.schoolId) ?? `School ${c.schoolId}`) : null
              }
              onChanged={refresh}
            />
          ))
        : null}
    </section>
  );
}

function percentText(part: number, whole: number): string {
  if (whole <= 0) return '';
  return ` (${Math.floor((part * 100) / whole)}%)`;
}

function CampaignCard({
  campaign: c,
  templateName,
  schoolName,
  onChanged,
}: {
  campaign: Campaign;
  templateName: string;
  schoolName: string | null;
  onChanged: () => void;
}) {
  const { api } = useSession();
  const titleId = useId();
  const { busy, feedback, run } = useAdminAction();
  const [editing, setEditing] = useState<{ channel: Channel; paidSlots: number } | null>(null);
  const [showCodes, setShowCodes] = useState(false);
  const availability = campaignRedeemability(c);

  const act = (action: CampaignAction) =>
    run(action, async () => {
      await api.send(
        'POST',
        `/v1/admin/campaigns/${c.id}/action`,
        { action },
        adminOkResponseSchema,
      );
      onChanged();
      return action === 'pause'
        ? 'Campaign paused.'
        : action === 'resume'
          ? 'Campaign resumed.'
          : 'Campaign revoked. Its codes can no longer be redeemed; confirmed benefits are kept.';
    });

  const canPause = c.status === 'active' || c.status === 'provisioning';
  const canResume = c.status === 'paused';
  const canRevoke = ['active', 'paused', 'provisioning', 'failed'].includes(c.status);
  const title = `${templateName} · ${c.percentOff}% off · ${monthLabel(c.campaignMonth)}`;

  return (
    <article
      aria-labelledby={titleId}
      style={{ borderTop: '1px solid #e3e8ee', padding: '12px 0' }}
    >
      <h3 id={titleId} style={{ margin: '0 0 4px' }}>
        {title}
      </h3>
      <p style={{ margin: 0 }}>Status: {STATUS_LABEL[c.status]}</p>
      <p style={{ margin: '4px 0' }}>
        Audience: {schoolName ?? 'Any eligible family'} · Window {formatUtc(c.opensAt)} to{' '}
        {formatUtc(c.closesAt)}
      </p>
      <p style={{ margin: '4px 0' }}>
        {c.liveRedemptions.toLocaleString('en-US')} of {c.redemptionCap.toLocaleString('en-US')}{' '}
        redemptions ({c.confirmedRedemptions.toLocaleString('en-US')} confirmed)
        {percentText(c.liveRedemptions, c.redemptionCap)}
      </p>
      <p style={{ margin: '4px 0' }}>
        {formatUsd(c.committedDiscountCents)} of {formatUsd(c.budgetCapCents)} discount budget
        committed{percentText(c.committedDiscountCents, c.budgetCapCents)}
      </p>
      {availability.redeemable ? (
        <p style={{ margin: '4px 0' }}>Redeemable on: {availability.channels.join(' · ')}</p>
      ) : (
        <p className="notice" style={{ margin: '4px 0' }}>
          {availability.notice}
        </p>
      )}
      <div style={buttonRow}>
        {canPause ? (
          <ConfirmButton
            label="Pause campaign"
            secondary
            disabled={busy !== null}
            prompt="Pause this campaign? New redemptions stop until you resume it. Confirmed benefits are not affected."
            confirmLabel="Yes, pause"
            onConfirm={() => act('pause')}
          />
        ) : null}
        {canResume ? (
          <ConfirmButton
            label="Resume campaign"
            disabled={busy !== null}
            prompt="Resume this campaign? Families can redeem its code again within the window and caps."
            confirmLabel="Yes, resume"
            onConfirm={() => act('resume')}
          />
        ) : null}
        {canRevoke ? (
          <ConfirmButton
            label="Revoke campaign"
            secondary
            disabled={busy !== null}
            prompt="Revoke this campaign? Its codes stop working permanently. Benefits already confirmed by a store are never taken back."
            confirmLabel="Yes, revoke"
            onConfirm={() => act('revoke')}
          />
        ) : null}
        <button
          type="button"
          className="btn secondary"
          aria-expanded={showCodes}
          onClick={() => setShowCodes((v) => !v)}
        >
          {showCodes ? 'Hide codes' : 'Show codes'}
        </button>
      </div>
      <AdminFeedback
        feedback={feedback}
        rules={{
          INVALID_TRANSITION: 'That action isn’t possible for the campaign’s current status.',
        }}
      />
      <MappingGrid
        campaign={c}
        onEdit={(channel, paidSlots) => setEditing({ channel, paidSlots })}
      />
      {editing ? (
        <OfferMappingEditor
          key={`${editing.channel}:${editing.paidSlots}`}
          campaignId={c.id}
          percentOff={c.percentOff}
          channel={editing.channel}
          paidSlots={editing.paidSlots}
          current={c.offerMappings.find(
            (m) => m.channel === editing.channel && m.paidSlots === editing.paidSlots,
          )}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
          onCancel={() => setEditing(null)}
        />
      ) : null}
      {showCodes ? <CodesView campaignId={c.id} /> : null}
    </article>
  );
}

function MappingGrid({
  campaign: c,
  onEdit,
}: {
  campaign: Campaign;
  onEdit: (channel: Channel, paidSlots: number) => void;
}) {
  return (
    <TableScroll label="Store offer mappings table">
      <table style={{ ...tableStyle, marginTop: 8 }} aria-label="Store offer mappings">
        <thead>
          <tr>
            <th style={cellStyle}>Store</th>
            {TIERS.map((tier) => (
              <th key={tier} style={cellStyle}>
                {tierLabel(tier)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {CHANNELS.map((channel) => (
            <tr key={channel}>
              <th style={cellStyle} scope="row">
                {CHANNEL_LABEL[channel]}
              </th>
              {TIERS.map((tier) => {
                const mapping = c.offerMappings.find(
                  (m) => m.channel === channel && m.paidSlots === tier,
                );
                const blocked = unsupportedReason(channel, tier, c.percentOff);
                return (
                  <td key={tier} style={cellStyle}>
                    <div>{mappingCellStatus(mapping, c)}</div>
                    {mapping?.providerOfferId ? (
                      <div style={{ color: 'var(--muted)' }}>Offer: {mapping.providerOfferId}</div>
                    ) : null}
                    {mapping?.reason ? (
                      <div style={{ color: 'var(--muted)' }}>Reason: {mapping.reason}</div>
                    ) : null}
                    {blocked && mapping?.status !== 'unsupported' ? (
                      <div style={{ color: 'var(--danger)' }}>⚠ Not a store price point</div>
                    ) : null}
                    <button
                      type="button"
                      className="btn secondary"
                      style={{ marginTop: 4 }}
                      aria-label={`Edit ${cellLabel(channel, tier)}`}
                      onClick={() => onEdit(channel, tier)}
                    >
                      Edit
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

function CodesView({ campaignId }: { campaignId: string }) {
  const query = useApiQuery(
    (api) => api.get(`/v1/admin/campaigns/${campaignId}/codes`, campaignCodesResponseSchema),
    [campaignId],
  );
  return (
    <div style={{ marginTop: 8 }}>
      <p style={{ color: 'var(--muted)' }}>
        Viewing codes is recorded in the audit log. Share a code only with its intended audience,
        and only once a store mapping is ready.
      </p>
      {query.status === 'loading' ? <Loading label="Loading codes…" /> : null}
      {query.status === 'error' ? (
        <ErrorState message={adminErrorMessage(query.error)} onRetry={query.reload} />
      ) : null}
      {query.status === 'ready' && query.data.codes.length === 0 ? (
        <p>This campaign has no codes.</p>
      ) : null}
      {query.status === 'ready' && query.data.codes.length > 0 ? (
        <TableScroll label="Codes table">
          <table style={tableStyle} aria-label="Campaign codes">
            <thead>
              <tr>
                <th style={cellStyle}>Code</th>
                <th style={cellStyle}>Code usage cap</th>
                <th style={cellStyle}>Status</th>
              </tr>
            </thead>
            <tbody>
              {query.data.codes.map((code) => (
                <tr key={code.id}>
                  <td style={{ ...cellStyle, fontFamily: 'ui-monospace, monospace' }}>
                    {code.code}
                  </td>
                  <td style={cellStyle}>
                    {code.usageCap === null ? 'No code cap (campaign cap applies)' : code.usageCap}
                  </td>
                  <td style={cellStyle}>{code.status === 'active' ? 'Active' : 'Revoked'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      ) : null}
    </div>
  );
}
