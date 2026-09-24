import { useCallback, useEffect, useState } from 'react';
import { router } from 'expo-router';
import type { ChildPracticeSet, ChildReviews } from '@pencillift/contracts';
import { childApi } from '../../src/family/runtime.ts';
import {
  Body,
  Button,
  Card,
  Heading,
  Loading,
  Notice,
  Screen,
  Title,
} from '../../src/family/ui.tsx';
import { PracticePlayer } from '../../src/learning/player.tsx';
import { loadCurrentReview } from '../../src/learning/practice-api.ts';
import { childLearningError, reviewStateCopy } from '../../src/learning/result-copy.ts';
import {
  buildReviewView,
  findReviewSet,
  replaceReviewSet,
} from '../../src/learning/review-view.ts';

type ScreenState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: ChildReviews };

/**
 * Child weekly review (spec P8, P14 child "Thursday subject review"). The review comes in short
 * subject sections that can be finished separately, in any order; optional extra practice is
 * labeled optional. Each section opens the same one-question-at-a-time player as daily practice.
 */
export default function ReviewScreen() {
  const [state, setState] = useState<ScreenState>({ status: 'loading' });
  const [openSetId, setOpenSetId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState((s) => (s.status === 'ready' ? s : { status: 'loading' }));
    try {
      setState({ status: 'ready', data: await loadCurrentReview(childApi) });
    } catch (error) {
      setState({ status: 'error', message: childLearningError(error) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const updateSet = (set: ChildPracticeSet) =>
    setState((s) =>
      s.status === 'ready' ? { status: 'ready', data: replaceReviewSet(s.data, set) } : s,
    );

  const openSet =
    state.status === 'ready' && openSetId !== null ? findReviewSet(state.data, openSetId) : null;
  const openSection =
    state.status === 'ready' && openSet
      ? state.data.sections.find((s) => s.sets.some((set) => set.id === openSet.id))
      : undefined;

  if (openSet) {
    return (
      <Screen>
        <Title>{openSection ? `${openSection.displayName} review` : 'Weekly review'}</Title>
        <PracticePlayer
          key={openSet.id}
          api={childApi}
          set={openSet}
          onSetChange={updateSet}
          onReload={() => {
            setOpenSetId(null);
            void load();
          }}
          onDone={() => setOpenSetId(null)}
          doneLabel="Back to my review"
        />
        <Button
          label="Choose another subject"
          secondary
          accessibilityLabel="Leave this section and choose another subject"
          onPress={() => setOpenSetId(null)}
        />
      </Screen>
    );
  }

  const view = state.status === 'ready' ? buildReviewView(state.data) : null;
  const stateCopy = state.status === 'ready' ? reviewStateCopy(state.data.state) : null;

  return (
    <Screen>
      <Title>My weekly review</Title>
      {state.status === 'loading' ? <Loading label="Getting your review" /> : null}
      {state.status === 'error' ? (
        <Notice alert>
          <Body>{state.message}</Body>
          <Button label="Try again" onPress={() => void load()} />
        </Notice>
      ) : null}
      {stateCopy && view && view.sections.length === 0 ? (
        <Notice>
          <Body>{stateCopy.title}</Body>
          <Body muted>{stateCopy.message}</Body>
          <Button label="Check again" secondary onPress={() => void load()} />
        </Notice>
      ) : null}
      {view && view.sections.length > 0 ? (
        <>
          <Body>
            Pick a subject. Each one is short, and you can do them in any order.
            {view.summary ? ` ${view.summary}.` : ''}
          </Body>
          {view.allDone ? (
            <Notice>
              <Body>★ You finished every subject this week. Great work!</Body>
            </Notice>
          ) : null}
          {view.sections.map((section) => (
            <Card key={section.subjectKey}>
              <Heading>
                {section.complete ? '✓ ' : ''}
                {section.title}
              </Heading>
              {section.sets.map((set) => (
                <Card key={set.id}>
                  <Body>
                    {set.label} · {set.questionCount}{' '}
                    {set.questionCount === 1 ? 'question' : 'questions'}
                  </Body>
                  <Body muted>
                    {set.statusLabel} · {set.progressLabel}
                  </Body>
                  <Button
                    label={set.actionLabel}
                    secondary={set.complete || set.optional}
                    accessibilityLabel={set.a11yLabel}
                    onPress={() => setOpenSetId(set.id)}
                  />
                </Card>
              ))}
            </Card>
          ))}
        </>
      ) : null}
      <Button
        label="Today’s practice"
        secondary
        accessibilityLabel="Open today’s practice"
        onPress={() => router.push('/(child)/practice')}
      />
    </Screen>
  );
}
