import { useCallback, useEffect, useState } from 'react';
import { router } from 'expo-router';
import type { ChildPracticeSet, ChildPracticeToday } from '@pencillift/contracts';
import { childApi } from '../../src/family/runtime.ts';
import { Body, Button, Loading, Notice, Screen, Title } from '../../src/family/ui.tsx';
import { PracticePlayer } from '../../src/learning/player.tsx';
import { loadPracticeToday } from '../../src/learning/practice-api.ts';
import { childLearningError, todayStateCopy } from '../../src/learning/result-copy.ts';

type ScreenState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; today: ChildPracticeToday };

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * Child daily practice (spec P7 "daily extra credit", P14 child "daily challenge"). One question at
 * a time with server-side checking; preparing, paused and not-yet-open states are explained calmly.
 * Missing or pausing a day never costs points. No ads, prices or adult data on this screen.
 */
export default function PracticeScreen() {
  const [state, setState] = useState<ScreenState>({ status: 'loading' });

  const load = useCallback(async () => {
    setState((s) => (s.status === 'ready' ? s : { status: 'loading' }));
    try {
      setState({ status: 'ready', today: await loadPracticeToday(childApi) });
    } catch (error) {
      setState({ status: 'error', message: childLearningError(error) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const updateSet = (set: ChildPracticeSet) =>
    setState((s) => (s.status === 'ready' ? { status: 'ready', today: { ...s.today, set } } : s));

  return (
    <Screen>
      <Title>Today’s practice</Title>
      {state.status === 'loading' ? <Loading label="Getting your practice" /> : null}
      {state.status === 'error' ? (
        <Notice alert>
          <Body>{state.message}</Body>
          <Button label="Try again" onPress={() => void load()} />
        </Notice>
      ) : null}
      {state.status === 'ready' && state.today.state === 'available' && state.today.set ? (
        <PracticePlayer
          key={state.today.set.id}
          api={childApi}
          set={state.today.set}
          onSetChange={updateSet}
          onReload={() => void load()}
          onDone={() => (router.canGoBack() ? router.back() : router.replace('/(child)/home'))}
          doneLabel="Back home"
        />
      ) : null}
      {state.status === 'ready' && !(state.today.state === 'available' && state.today.set) ? (
        <TodayState today={state.today} onRefresh={() => void load()} />
      ) : null}
      <Button
        label="My weekly review"
        secondary
        accessibilityLabel="Open my weekly review"
        onPress={() => router.push('/(child)/review')}
      />
    </Screen>
  );
}

function TodayState({ today, onRefresh }: { today: ChildPracticeToday; onRefresh: () => void }) {
  const copy = todayStateCopy(today, new Date(), formatTime);
  return (
    <Notice>
      <Body>{copy.title}</Body>
      <Body muted>{copy.message}</Body>
      {today.state === 'paused' ? null : (
        <Button label="Check again" secondary onPress={onRefresh} />
      )}
    </Notice>
  );
}
