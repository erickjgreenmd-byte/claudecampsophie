import { useCallback, useEffect, useState } from 'react';
import { Text } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import {
  PAIRING_STALE_COPY,
  createPairingCodeResponseSchema,
  familyOverviewResponseSchema,
  type HeldPairingCode,
} from '@pencillift/contracts';
import type { ApiClient } from '@pencillift/contracts/client';
import { pairDeviceView, parentActionError } from '../../src/family/family-view.ts';
import {
  Body,
  Button,
  Card,
  ErrorBox,
  formatDateTime,
  Heading,
  Loading,
  Notice,
  ParentAccessState,
  Screen,
  styles,
  Title,
  useLoad,
  useParentAccess,
} from '../../src/family/ui.tsx';

/**
 * Pair a child's device (spec P3, AC_ACCESS_04). The code is single-use, short-lived, bound to the
 * selected child only, and shown once. Creating it needs a recent parent PIN unlock (server-side).
 *
 * BUG-411 (g): this screen used to hold the minted code in `useState` and print it unconditionally.
 * It read no status — it is reached with a `childId` route param and fetched nothing — so a consent
 * withdrawal that retires the code, or the other guardian archiving the child, or a child-scope
 * deletion request, left a parent reading a code the tablet will refuse with nothing on screen saying
 * so. The portal spent BUG-393, BUG-395 and BUG-397 on exactly this rule and the phone had none of it.
 * It now reads GET /v1/family like the Children screen and decides through the shared
 * `pairDeviceView` (src/family/family-view.ts), whose decisions are `packages/contracts/src/family.ts`.
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
          <PairCode api={access.api} childId={childId} fallbackNickname={nickname} />
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
  fallbackNickname,
}: {
  api: ApiClient;
  childId: string;
  fallbackNickname: string;
}) {
  // The child's live status, which this screen had no source for at all. The Children screen's row is
  // frozen into the route params at navigation, and a code's fate is decided by the status NOW.
  const load = useCallback(() => api.get('/v1/family', familyOverviewResponseSchema), [api]);
  const { state, reload } = useLoad(load);
  const [held, setHeld] = useState<HeldPairingCode>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; needsPin: boolean } | null>(null);

  const view =
    state.status === 'ready' ? pairDeviceView(state.data, childId, fallbackNickname, held) : null;
  /** What may be rendered where a code would go; `held` itself until the family has loaded. */
  const shown = view ? view.held : held;
  /**
   * The latch, and the whole of it: writing the rendered answer back means a code once turned stale is
   * never turned back, so activating the child again does not resurrect a code the server has already
   * refused. `shown` is `held` itself while the profile is redeemable, so this runs only when the
   * answer changes. It decides NOTHING — `heldPairingCode` inside `pairDeviceView` does, at the render.
   */
  useEffect(() => {
    setHeld(shown);
  }, [shown]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.send(
        'POST',
        `/v1/children/${encodeURIComponent(childId)}/pairing-code`,
        undefined,
        createPairingCodeResponseSchema,
      );
      // Stored as it came back; whether it may be PRINTED is decided at the render below, from the
      // child of that render (BUG-397). The reload is what gives that render something newer than the
      // status this screen loaded with: a code minted after a withdrawal or an archive is exactly the
      // case an effect racing the code's arrival could not catch.
      setHeld(result);
      await reload();
    } catch (e) {
      const mapped = parentActionError(e);
      setError({ message: mapped.message, needsPin: mapped.needsPin });
    } finally {
      setBusy(false);
    }
  };

  if (state.status === 'idle' || state.status === 'loading') {
    return <Loading label="Loading your family" />;
  }
  if (state.status === 'error') {
    const loadError = parentActionError(state.error, 'load');
    return (
      <ErrorBox
        message={loadError.message}
        onRetry={loadError.noFamily ? undefined : () => void reload()}
      />
    );
  }
  if (!view) return null;

  return (
    <Card>
      <Heading>Code for {view.nickname}</Heading>
      <Body muted>Status: {view.statusText}</Body>
      {/*
        The "notices above" the stale notice defers to, on the screen it defers to them from. The
        Create control is above the panel for the same reason: the shared sentence says a new code can
        be created "above", and on this screen that is now true.
      */}
      {view.pairingNote ? <Body>{view.pairingNote}</Body> : null}
      {view.canCreate ? (
        <>
          <Body>
            Create a one-time code to connect {view.nickname}’s device. The code expires after a few
            minutes.
          </Body>
          <Button
            label={busy ? 'Creating…' : 'Create pairing code'}
            accessibilityLabel={`Create a pairing code for ${view.nickname}`}
            busy={busy}
            onPress={() => void create()}
          />
        </>
      ) : null}
      {error ? <ErrorBox message={error.message} needsPin={error.needsPin} /> : null}
      {shown === null ? null : shown === 'stale' ? (
        <Notice>
          <Body>
            {PAIRING_STALE_COPY.headline} {PAIRING_STALE_COPY.reason} {view.staleNextStep}{' '}
            {PAIRING_STALE_COPY.consentLead} {PAIRING_STALE_COPY.consentTarget}.
          </Body>
          <Button
            label={`Review consent on the ${PAIRING_STALE_COPY.consentTarget}`}
            secondary
            onPress={() => router.push('/(parent)/home')}
          />
          <Button label="Done" secondary onPress={() => setHeld(null)} />
        </Notice>
      ) : (
        <>
          <Text
            style={styles.code}
            accessibilityLabel={`Pairing code ${shown.code.split('').join(' ')}`}
            selectable={false}
          >
            {shown.code}
          </Text>
          <Body>Expires at {formatDateTime(shown.expiresAt)}.</Body>
          <Body>
            On {view.nickname}’s device, open PencilLift, choose “Connect a child’s device” and
            enter this code. It works once and connects only {view.nickname}’s profile. Creating a
            new code cancels this one.
          </Body>
          <Body muted>This code is shown only once. Don’t share it outside your family.</Body>
          <Button
            label="Done"
            onPress={() => {
              setHeld(null);
              router.back();
            }}
          />
        </>
      )}
    </Card>
  );
}
