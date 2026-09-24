import { useState } from 'react';
import { Text } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { createPairingCodeResponseSchema } from '@pencillift/contracts';
import type { ApiClient } from '@pencillift/contracts/client';
import { parentActionError } from '../../src/family/family-view.ts';
import {
  Body,
  Button,
  Card,
  ErrorBox,
  formatDateTime,
  Heading,
  ParentAccessState,
  Screen,
  styles,
  Title,
  useParentAccess,
} from '../../src/family/ui.tsx';

/**
 * Pair a child's device (spec P3, AC_ACCESS_04). The code is single-use, short-lived, bound to the
 * selected child only, and shown once. Creating it needs a recent parent PIN unlock (server-side).
 */
export default function PairDeviceScreen() {
  const access = useParentAccess();
  const params = useLocalSearchParams<{ childId?: string; nickname?: string }>();
  const childId = typeof params.childId === 'string' ? params.childId : null;
  const nickname = typeof params.nickname === 'string' ? params.nickname : 'your child';
  return (
    <Screen>
      <Title>Pair a device</Title>
      <ParentAccessState access={access} />
      {access.status === 'ready' ? (
        childId ? (
          <PairCode api={access.api} childId={childId} nickname={nickname} />
        ) : (
          <ErrorBox message="Choose a child on the Children screen first." />
        )
      ) : null}
    </Screen>
  );
}

function PairCode({
  api,
  childId,
  nickname,
}: {
  api: ApiClient;
  childId: string;
  nickname: string;
}) {
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<{ message: string; needsPin: boolean } | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      setCode(
        await api.send(
          'POST',
          `/v1/children/${encodeURIComponent(childId)}/pairing-code`,
          undefined,
          createPairingCodeResponseSchema,
        ),
      );
    } catch (e) {
      const mapped = parentActionError(e);
      setError({ message: mapped.message, needsPin: mapped.needsPin });
    } finally {
      setBusy(false);
    }
  };

  if (code) {
    return (
      <Card>
        <Heading>Code for {nickname}</Heading>
        <Text
          style={styles.code}
          accessibilityLabel={`Pairing code ${code.code.split('').join(' ')}`}
          selectable={false}
        >
          {code.code}
        </Text>
        <Body>Expires at {formatDateTime(code.expiresAt)}.</Body>
        <Body>
          On {nickname}’s device, open PencilLift, choose “Connect a child’s device” and enter this
          code. It works once and connects only {nickname}’s profile. Creating a new code cancels
          this one.
        </Body>
        <Body muted>This code is shown only once. Don’t share it outside your family.</Body>
        <Button
          label="Done"
          onPress={() => {
            setCode(null);
            router.back();
          }}
        />
      </Card>
    );
  }

  return (
    <Card>
      <Body>
        Create a one-time code to connect {nickname}’s device. The code expires after a few minutes.
      </Body>
      <Button
        label={busy ? 'Creating…' : 'Create pairing code'}
        busy={busy}
        onPress={() => void create()}
      />
      {error ? <ErrorBox message={error.message} needsPin={error.needsPin} /> : null}
    </Card>
  );
}
