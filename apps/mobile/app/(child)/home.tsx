import { useCallback, useEffect, useState } from 'react';
import { router, type Href } from 'expo-router';
import { childMeResponseSchema } from '@pencillift/contracts';
import { ApiRequestError } from '@pencillift/contracts/client';
import { childApi, childSession } from '../../src/family/runtime.ts';
import { Body, Button, Card, Loading, Notice, Screen, Title } from '../../src/family/ui.tsx';

/**
 * Child home (spec P14 child "home/mission"). Only the child's own nickname comes from the server;
 * no adult data, prices, ads or purchases appear here. Copy is calm and encouraging.
 */

type HomeState =
  | { status: 'loading' }
  | { status: 'not_connected' }
  | { status: 'offline'; nickname: string | null }
  | { status: 'ready'; nickname: string };

const ACTIONS: readonly { label: string; hint: string; href: Href }[] = [
  { label: 'Check my homework', hint: 'Take a photo of finished homework', href: '/(child)/scan' },
  {
    label: 'My results',
    hint: 'See what went well and what to try again',
    href: '/(child)/results',
  },
  {
    label: 'Today’s practice',
    hint: 'A few questions to practice today',
    href: '/(child)/practice',
  },
  { label: 'My weekly review', hint: 'Short review sections by subject', href: '/(child)/review' },
  { label: 'My rewards', hint: 'See your points and rewards', href: '/(child)/rewards' },
  {
    label: 'Get help',
    hint: 'Ask for help or tell a grown-up about a problem',
    href: '/(child)/help',
  },
];

export default function ChildHomeScreen() {
  const [state, setState] = useState<HomeState>({ status: 'loading' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    const cached = await childSession.profile();
    try {
      const token = await childSession.accessToken();
      if (!token) {
        setState({ status: 'not_connected' });
        return;
      }
      const me = await childApi.get('/v1/child/me', childMeResponseSchema);
      setState({ status: 'ready', nickname: me.nickname });
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'UNAUTHENTICATED') {
        setState({ status: 'not_connected' });
        return;
      }
      setState({ status: 'offline', nickname: cached?.nickname ?? null });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.status === 'loading') {
    return (
      <Screen>
        <Loading label="Getting your space ready" />
      </Screen>
    );
  }

  if (state.status === 'not_connected') {
    return (
      <Screen>
        <Title>Hi there!</Title>
        <Notice>
          <Body>This device isn’t connected yet. Ask a grown-up for a connect code.</Body>
          <Button label="Enter a connect code" onPress={() => router.replace('/pair')} />
        </Notice>
        {/* MOB-R4-LOCK-05: without this, a device left in child mode with no usable child session
            offered a grown-up no way out of the child space at all. */}
        <Button
          label="Grown-ups"
          secondary
          accessibilityLabel="Grown-ups: parent area, needs the parent PIN"
          onPress={() => router.push('/(parent)/unlock')}
        />
      </Screen>
    );
  }

  const { nickname } = state;
  return (
    <Screen>
      <Title>{nickname ? `Hi, ${nickname}!` : 'Hi there!'}</Title>
      <Body>What would you like to do today?</Body>
      {state.status === 'offline' ? (
        <Notice>
          <Body>We can’t reach PencilLift right now. Check the internet, then try again.</Body>
          <Button label="Try again" secondary onPress={() => void load()} />
        </Notice>
      ) : null}
      {ACTIONS.map((action) => (
        <Card key={action.label}>
          <Button
            label={action.label}
            accessibilityLabel={`${action.label}. ${action.hint}`}
            onPress={() => router.push(action.href)}
          />
          <Body muted>{action.hint}</Body>
        </Card>
      ))}
      <Button
        label="Grown-ups"
        secondary
        accessibilityLabel="Grown-ups: parent area, needs the parent PIN"
        onPress={() => router.push('/(parent)/unlock')}
      />
    </Screen>
  );
}
