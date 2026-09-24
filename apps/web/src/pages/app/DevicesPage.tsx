import { useId, useState } from 'react';
import { Link } from 'react-router';
import {
  childDevicesResponseSchema,
  familyOkResponseSchema,
  familyOverviewResponseSchema,
  type ChildDevice,
} from '@pencillift/contracts';
import { EmptyState, ErrorState, Loading } from '../../components/states.tsx';
import { RequireParent, useApiQuery, useSession } from '../../lib/session.tsx';
import {
  ActionFeedback,
  buttonRow,
  formatDate,
  sectionStyle,
  useAction,
  useLastGood,
} from './SecurityPage.tsx';

/**
 * Paired child devices (spec P3, P14 "security/devices"; AC_ACCESS_08). Disconnecting a device
 * revokes its child session at once: the next request or token refresh from it fails.
 */
export default function DevicesPage() {
  return (
    <RequireParent>
      <Devices />
    </RequireParent>
  );
}

const PLATFORM_LABEL: Record<ChildDevice['platform'], string> = {
  ios: 'iPhone or iPad',
  android: 'Android',
  web: 'Web browser',
};

function Devices() {
  const query = useApiQuery(async (api) => {
    const [devices, family] = await Promise.all([
      api.get('/v1/devices', childDevicesResponseSchema),
      api.get('/v1/family', familyOverviewResponseSchema),
    ]);
    return {
      devices: devices.devices,
      names: new Map(family.children.map((c) => [c.id, c.nickname])),
    };
  }, []);
  const data = useLastGood(query);

  return (
    <>
      <h1>Devices</h1>
      <p>
        These are the devices connected to a child’s profile. Disconnecting a device signs it out
        immediately; it needs a new pairing code to connect again.
      </p>
      {data === null && query.status === 'loading' ? <Loading label="Loading devices…" /> : null}
      {query.status === 'error' ? (
        query.error.code === 'NOT_FOUND' ? (
          <EmptyState title="Create your family first">
            <p>
              Set up your family on the <Link to="/app">family dashboard</Link> first.
            </p>
          </EmptyState>
        ) : (
          <ErrorState message={query.error.message} onRetry={query.reload} />
        )
      ) : null}
      {data ? (
        data.devices.length === 0 ? (
          <EmptyState title="No devices connected yet">
            <p>
              Create a pairing code on the <Link to="/app/children">Children page</Link>, then enter
              it on your child’s device.
            </p>
          </EmptyState>
        ) : (
          <ul
            aria-busy={query.status === 'loading'}
            style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 12 }}
          >
            {data.devices.map((device) => (
              <DeviceCard
                key={device.id}
                device={device}
                childName={data.names.get(device.childId) ?? 'A child'}
                onChanged={query.reload}
              />
            ))}
          </ul>
        )
      ) : null}
    </>
  );
}

function DeviceCard({
  device,
  childName,
  onChanged,
}: {
  device: ChildDevice;
  childName: string;
  onChanged: () => void;
}) {
  const { api } = useSession();
  const { busy, feedback, run } = useAction();
  const [confirming, setConfirming] = useState(false);
  const titleId = useId();

  const revoke = async () => {
    const ok = await run('revoke', async () => {
      await api.send('POST', `/v1/devices/${device.id}/revoke`, undefined, familyOkResponseSchema);
      return `${device.label} was disconnected.`;
    });
    setConfirming(false);
    if (ok) onChanged();
  };

  return (
    <li className="card" aria-labelledby={titleId}>
      <h2 id={titleId} style={{ margin: 0, fontSize: '1.2rem' }}>
        {device.label}
      </h2>
      <p style={{ margin: '4px 0' }}>
        {childName}’s device · {PLATFORM_LABEL[device.platform]} · paired{' '}
        {formatDate(device.pairedAt)}
      </p>
      <p style={{ margin: '4px 0', fontWeight: 700 }}>
        Status: {device.revokedAt ? `Disconnected on ${formatDate(device.revokedAt)}` : 'Connected'}
      </p>
      {device.revokedAt === null && !confirming ? (
        <div style={buttonRow}>
          <button
            type="button"
            className="btn secondary"
            disabled={busy !== null}
            onClick={() => setConfirming(true)}
          >
            Disconnect
          </button>
        </div>
      ) : null}
      {confirming ? (
        <div className="notice" role="group" aria-label="Confirm disconnect" style={sectionStyle}>
          <p style={{ margin: 0 }}>
            Disconnect {device.label}? {childName} will be signed out on it and will need a new
            pairing code.
          </p>
          <div style={buttonRow}>
            <button
              type="button"
              className="btn"
              disabled={busy !== null}
              onClick={() => void revoke()}
            >
              {busy === 'revoke' ? 'Disconnecting…' : 'Yes, disconnect'}
            </button>
            <button
              type="button"
              className="btn secondary"
              disabled={busy !== null}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      <ActionFeedback feedback={feedback} stepUpAction="Disconnecting a device" />
    </li>
  );
}
