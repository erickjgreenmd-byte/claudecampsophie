import { useCallback, useState } from 'react';
import {
  childDevicesResponseSchema,
  familyOkResponseSchema,
  familyOverviewResponseSchema,
} from '@pencillift/contracts';
import type { ApiClient } from '@pencillift/contracts/client';
import { deviceRows, parentActionError, type DeviceRow } from '../../src/family/family-view.ts';
import {
  Body,
  Button,
  Card,
  ErrorBox,
  Heading,
  Loading,
  Notice,
  ParentAccessState,
  Screen,
  Title,
  useLoad,
  useParentAccess,
} from '../../src/family/ui.tsx';

/**
 * Connected child devices (spec P3, P14 security/devices; AC_ACCESS_08). Disconnecting revokes the
 * device's child session immediately; it needs a new pairing code to connect again.
 */
export default function DevicesScreen() {
  const access = useParentAccess();
  return (
    <Screen>
      <Title>Devices</Title>
      <ParentAccessState access={access} />
      {access.status === 'ready' ? <DeviceList api={access.api} /> : null}
    </Screen>
  );
}

function DeviceList({ api }: { api: ApiClient }) {
  const load = useCallback(async () => {
    const [devices, family] = await Promise.all([
      api.get('/v1/devices', childDevicesResponseSchema),
      api.get('/v1/family', familyOverviewResponseSchema),
    ]);
    return deviceRows(devices.devices, family);
  }, [api]);
  const { state, reload } = useLoad(load);

  if (state.status === 'idle' || state.status === 'loading') {
    return <Loading label="Loading devices" />;
  }
  if (state.status === 'error') {
    const error = parentActionError(state.error, 'load');
    return (
      <ErrorBox
        message={error.message}
        onRetry={error.noFamily ? undefined : () => void reload()}
      />
    );
  }
  if (state.data.length === 0) {
    return (
      <Card>
        <Body>No devices are connected yet. Create a pairing code from the Children screen.</Body>
      </Card>
    );
  }
  return (
    <>
      {state.data.map((row) => (
        <DeviceCard key={row.id} api={api} row={row} onChanged={() => void reload()} />
      ))}
    </>
  );
}

function DeviceCard({
  api,
  row,
  onChanged,
}: {
  api: ApiClient;
  row: DeviceRow;
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; needsPin: boolean } | null>(null);

  const revoke = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.send('POST', `/v1/devices/${row.id}/revoke`, undefined, familyOkResponseSchema);
      setConfirming(false);
      onChanged();
    } catch (e) {
      const mapped = parentActionError(e);
      setError({ message: mapped.message, needsPin: mapped.needsPin });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Heading>{row.title}</Heading>
      <Body>{row.detail}</Body>
      <Body muted>Status: {row.statusText}</Body>
      {row.canRevoke && !confirming ? (
        <Button
          label="Disconnect"
          secondary
          accessibilityLabel={`Disconnect ${row.title}`}
          onPress={() => setConfirming(true)}
        />
      ) : null}
      {confirming ? (
        <Notice>
          <Body>Disconnect {row.title}? It will be signed out and need a new pairing code.</Body>
          <Button
            label={busy ? 'Disconnecting…' : 'Yes, disconnect'}
            busy={busy}
            onPress={() => void revoke()}
          />
          <Button label="Cancel" secondary disabled={busy} onPress={() => setConfirming(false)} />
        </Notice>
      ) : null}
      {error ? <ErrorBox message={error.message} needsPin={error.needsPin} /> : null}
    </Card>
  );
}
