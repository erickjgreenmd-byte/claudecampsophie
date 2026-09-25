import { useCallback, useState } from 'react';
import { Linking } from 'react-native';
import { router } from 'expo-router';
import {
  consentStartResponseSchema,
  consentStatusResponseSchema,
  familyOverviewResponseSchema,
  guardiansResponseSchema,
  type ConsentStatus,
} from '@pencillift/contracts';
import type { ApiClient } from '@pencillift/contracts/client';
import { consentBanner, type ConsentAction } from '../../src/family/consent.ts';
import { childRows, parentActionError, slotSummary } from '../../src/family/family-view.ts';
import { guardianSummary } from '../../src/family/guardians.ts';
import {
  Body,
  Button,
  Card,
  ErrorBox,
  Heading,
  LegalLinks,
  Loading,
  Notice,
  ParentAccessState,
  Screen,
  Title,
  useLoad,
  useParentAccess,
} from '../../src/family/ui.tsx';
import { lockParentArea } from '../../src/family/unlock.ts';

/**
 * Parent home (spec P14 parent area; AC_ACCESS_01/02, AC_UX_02): family, children and paid slots,
 * the consent state (honest about test providers), guardians, and the ways into the other screens.
 */
export default function ParentHomeScreen() {
  const access = useParentAccess();
  return (
    <Screen>
      <Title>Your family</Title>
      <ParentAccessState access={access} />
      {access.status === 'ready' ? <FamilyHome api={access.api} /> : null}
    </Screen>
  );
}

function FamilyHome({ api }: { api: ApiClient }) {
  const load = useCallback(async () => {
    const [family, consent, guardians] = await Promise.all([
      api.get('/v1/family', familyOverviewResponseSchema),
      api.get('/v1/consent', consentStatusResponseSchema).catch(() => null),
      api.get('/v1/guardians', guardiansResponseSchema).catch(() => null),
    ]);
    return { family, consent, guardians };
  }, [api]);
  const { state, reload } = useLoad(load);

  if (state.status === 'idle' || state.status === 'loading') {
    return <Loading label="Loading your family" />;
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
  const { family, consent, guardians } = state.data;
  const guardianView = guardians ? guardianSummary(guardians) : null;
  return (
    <>
      <Card>
        <Heading>{family.displayName}</Heading>
        <Body>{slotSummary(family)}</Body>
        {family.billingConflict ? (
          <Body>Your subscription needs attention. Please review it in subscription settings.</Body>
        ) : null}
      </Card>

      <ConsentCard api={api} status={consent} onChanged={() => void reload()} />

      <Heading>Children</Heading>
      {family.children.length === 0 ? (
        <Body>No children yet. Add your first child as a free draft.</Body>
      ) : (
        childRows(family).map((row) => (
          <Card key={row.id}>
            <Body>
              {row.nickname} · {row.detail}
            </Body>
            <Body muted>Status: {row.statusText}</Body>
          </Card>
        ))
      )}
      <Button
        label="Manage children and pairing"
        onPress={() => router.push('/(parent)/children')}
      />
      <Button
        label="Connected devices"
        secondary
        onPress={() => router.push('/(parent)/devices')}
      />

      <Heading>Family tools</Heading>
      <Button label="Reward requests" onPress={() => router.push('/(parent)/rewards')} />
      <Button label="Learning planner" secondary onPress={() => router.push('/(parent)/planner')} />
      <Button label="Plan and billing" secondary onPress={() => router.push('/(parent)/plan')} />
      <Button
        label="School and promo codes"
        secondary
        onPress={() => router.push('/(parent)/school')}
      />
      <Button
        label="Parent resources"
        secondary
        onPress={() => router.push('/(parent)/resources')}
      />
      <Button label="Privacy and data" secondary onPress={() => router.push('/(parent)/privacy')} />
      <Button label="Support" secondary onPress={() => router.push('/(parent)/support')} />
      <Body muted>Our full policies, on the parent portal:</Body>
      <LegalLinks />

      {guardianView ? (
        <>
          <Heading>Adults</Heading>
          <Card>
            {guardianView.lines.map((line) => (
              <Body key={line.key}>{line.text}</Body>
            ))}
            <Body muted>{guardianView.note}</Body>
          </Card>
        </>
      ) : null}

      <Heading>This device</Heading>
      <Body muted>
        Handing the device to your child? Connecting it as a child device clears the parent area
        from it and locks it. Coming back needs your parent PIN.
      </Body>
      <Button label="Connect as a child device" secondary onPress={() => router.push('/pair')} />
      <LockButton api={api} />
    </>
  );
}

function ConsentCard({
  api,
  status,
  onChanged,
}: {
  api: ApiClient;
  status: ConsentStatus | null;
  onChanged: () => void;
}) {
  const banner = consentBanner(status);
  const [busy, setBusy] = useState<ConsentAction | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [redirectUrl, setRedirectUrl] = useState<string | null>(null);

  const act = async (action: ConsentAction) => {
    if (!status || busy !== null || action === 'none') return;
    setBusy(action);
    setMessage(null);
    try {
      if (action === 'start') {
        const started = await api.send('POST', '/v1/consent/start', {}, consentStartResponseSchema);
        setRedirectUrl(started.redirectUrl);
        setMessage(
          started.redirectUrl
            ? 'Consent started. Continue with the consent provider, then check the status here.'
            : 'Consent started. Check the status to see the provider’s result.',
        );
      } else if (status.consentId) {
        await api.send(
          'POST',
          `/v1/consent/${status.consentId}/refresh`,
          undefined,
          consentStatusResponseSchema,
        );
      }
      onChanged();
    } catch (error) {
      setMessage(parentActionError(error).message);
    } finally {
      setBusy(null);
    }
  };

  const Wrapper = banner.tone === 'blocked' ? Notice : Card;
  return (
    <Wrapper>
      <Heading>{banner.title}</Heading>
      <Body>{banner.body}</Body>
      {banner.testNote ? <Body muted>{banner.testNote}</Body> : null}
      {banner.actionLabel ? (
        <Button
          label={banner.actionLabel}
          busy={busy === banner.action}
          disabled={busy !== null}
          onPress={() => void act(banner.action)}
        />
      ) : null}
      {banner.secondaryLabel ? (
        <Button
          label={banner.secondaryLabel}
          secondary
          busy={busy === banner.secondaryAction}
          disabled={busy !== null}
          onPress={() => void act(banner.secondaryAction)}
        />
      ) : null}
      {redirectUrl && status?.state === 'pending' ? (
        <Button
          label="Continue with the consent provider"
          secondary
          onPress={() => void Linking.openURL(redirectUrl).catch(() => undefined)}
        />
      ) : null}
      {message ? <Body>{message}</Body> : null}
    </Wrapper>
  );
}

function LockButton({ api }: { api: ApiClient }) {
  const [message, setMessage] = useState<string | null>(null);
  return (
    <>
      <Button
        label="Lock parent area"
        secondary
        onPress={() =>
          void lockParentArea(api).then((ok) =>
            setMessage(
              ok
                ? 'Locked. Sensitive actions need your PIN again.'
                : 'We couldn’t reach PencilLift to lock. Try again when you’re online.',
            ),
          )
        }
      />
      {message ? <Body>{message}</Body> : null}
    </>
  );
}
