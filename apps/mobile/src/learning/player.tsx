import * as Crypto from 'expo-crypto';
import { useMemo, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { ChildPracticeSet } from '@pencillift/contracts';
import type { ApiClient } from '@pencillift/contracts/client';
import { colors, radii, spacing, typography } from '@pencillift/ui-tokens';
import {
  ANSWER_MAX_LENGTH,
  choiceLetter,
  inputHint,
  inputProblemMessage,
  keyboardFor,
  normalizeAnswerInput,
} from './answer-input.ts';
import { createAnswerKeys, submitPracticeAnswer } from './practice-api.ts';
import {
  ASK_GROWN_UP_COPY,
  answerFeedback,
  completionCopy,
  finishedItemFeedback,
  methodSteps,
  type AnswerFeedback,
} from './result-copy.ts';
import {
  applyAnswer,
  firstOpenIndex,
  itemFinished,
  nextOpenIndex,
  positionLabel,
  setProgress,
} from './set-progress.ts';

/** Child buttons are larger than the 44pt minimum: young hands, big targets. */
const CHILD_TOUCH = 56;

type HelpView = 'method' | 'grown_up';

/**
 * One practice set, one question at a time (spec P6, P7, P8; AC_GRADING_06). Answers are checked
 * on the server; this component never has an answer to show. "Correct" / "Try again" appear with an
 * icon and text and are announced to screen readers. After three unsuccessful tries it offers
 * "Practice the method" or "Ask a grown-up" and the child can always move on (no lockout).
 * Logic lives in the pure modules next to this file (unit-tested); this is covered by typechecking.
 */
export function PracticePlayer({
  api,
  set,
  onSetChange,
  onReload,
  onDone,
  doneLabel,
}: {
  api: ApiClient;
  set: ChildPracticeSet;
  onSetChange: (set: ChildPracticeSet) => void;
  onReload: () => void;
  onDone: () => void;
  doneLabel: string;
}) {
  const keys = useMemo(() => createAnswerKeys(() => Crypto.randomUUID()), []);
  const [index, setIndex] = useState(() => firstOpenIndex(set.items));
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<Record<string, AnswerFeedback>>({});
  const [help, setHelp] = useState<Record<string, HelpView>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [points, setPoints] = useState(0);
  const [showCompletion, setShowCompletion] = useState(false);

  const total = set.items.length;
  const progress = setProgress(set.items);
  const item = set.items[Math.min(index, Math.max(total - 1, 0))];

  if (!item) {
    return (
      <View style={styles.card}>
        <Text style={styles.body}>There are no questions here yet. Check again later.</Text>
        <ChildButton label={doneLabel} onPress={onDone} />
      </View>
    );
  }

  if (showCompletion) {
    const copy = completionCopy(set.kind, points);
    return (
      <View style={[styles.card, styles.celebrate]} accessibilityLiveRegion="polite">
        <Text accessibilityRole="header" style={styles.celebrateTitle}>
          ★ {copy.title}
        </Text>
        <Text style={styles.body}>{copy.message}</Text>
        <ChildButton label={doneLabel} onPress={onDone} />
        <ChildButton
          label="Look at my questions again"
          secondary
          onPress={() => {
            setShowCompletion(false);
            setIndex(0);
          }}
        />
      </View>
    );
  }

  const format = item.prompt.responseFormat;
  const status = item.progress.status;
  const shown: AnswerFeedback | null =
    feedback[item.id] ??
    (status === 'correct' || status === 'help_offered' ? finishedItemFeedback(status) : null);
  const canAnswer = !itemFinished(status) && (shown === null || shown.canRetry);
  const draft = drafts[item.id] ?? '';
  const helpView = help[item.id];
  const next = nextOpenIndex(set.items, index);

  const announce = (text: string) => {
    AccessibilityInfo.announceForAccessibility(text);
  };

  const setDraft = (value: string) => {
    setDrafts((d) => ({ ...d, [item.id]: value }));
    setNotice(null);
    // A new attempt clears the old "Try again" so the next result is clearly about the new answer.
    if (shown && shown.canRetry) {
      setFeedback((f) => {
        const rest = { ...f };
        delete rest[item.id];
        return rest;
      });
    }
  };

  const check = async () => {
    if (busy || !canAnswer) return;
    const normalized = normalizeAnswerInput(draft, format, item.prompt.choices?.length ?? 0);
    if (!normalized.ok) {
      const message = inputProblemMessage(normalized.reason);
      setNotice(message);
      announce(message);
      return;
    }
    setBusy(true);
    setNotice(null);
    const outcome = await submitPracticeAnswer(api, keys, item.id, normalized.value);
    setBusy(false);
    if (!outcome.ok) {
      setNotice(outcome.message);
      announce(outcome.message);
      if (outcome.reload) onReload();
      return;
    }
    const result = answerFeedback(outcome.response);
    setFeedback((f) => ({ ...f, [item.id]: result }));
    setPoints((p) => p + outcome.response.pointsAwarded);
    // When this finished the set, the child sees the result first; "See how I did" follows.
    onSetChange(applyAnswer(set, item.id, outcome.response));
    announce(result.a11yLabel);
  };

  const goNext = () => {
    setNotice(null);
    if (next !== null) setIndex(next);
    else if (index + 1 < total) setIndex(index + 1);
  };

  const primaryAfterFinish = progress.complete ? (
    <ChildButton label="See how I did" onPress={() => setShowCompletion(true)} />
  ) : next !== null ? (
    <ChildButton label="Next question" onPress={goNext} />
  ) : null;

  return (
    <View>
      {set.intro ? <Text style={styles.intro}>{set.intro}</Text> : null}
      <Text style={styles.position}>
        {positionLabel(index, total)} · {progress.label}
      </Text>
      <View
        accessibilityRole="progressbar"
        accessibilityLabel="Questions done"
        accessibilityValue={{ min: 0, max: total, now: progress.finished, text: progress.label }}
        style={styles.track}
      >
        <View
          style={[styles.fill, { width: `${Math.round(progress.fraction * 100)}%` as const }]}
        />
      </View>

      <View style={styles.card}>
        <Text style={styles.topic}>{item.topic}</Text>
        {item.prompt.passage ? (
          <View style={styles.passage}>
            <Text accessibilityRole="header" style={styles.passageTitle}>
              {item.prompt.passage.title}
            </Text>
            <Text style={styles.body}>{item.prompt.passage.text}</Text>
          </View>
        ) : null}
        <Text style={styles.prompt}>{item.prompt.text}</Text>

        {format === 'choice' && item.prompt.choices ? (
          <View accessibilityRole="radiogroup" accessibilityLabel="Choices">
            {item.prompt.choices.map((choice, i) => {
              const letter = choiceLetter(i);
              const selected = draft === letter;
              return (
                <Pressable
                  key={`${letter}-${choice}`}
                  accessibilityRole="radio"
                  accessibilityLabel={`${letter}. ${choice}`}
                  accessibilityState={{ checked: selected, disabled: !canAnswer }}
                  disabled={!canAnswer}
                  onPress={() => setDraft(letter)}
                  style={[styles.choice, selected ? styles.choiceSelected : null]}
                >
                  <Text style={[styles.choiceText, selected ? styles.choiceTextSelected : null]}>
                    {selected ? '✓ ' : ''}
                    {letter}. {choice}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : (
          <View style={styles.answerRow}>
            <TextInput
              accessibilityLabel={
                item.prompt.unitHint ? `Your answer, in ${item.prompt.unitHint}` : 'Your answer'
              }
              accessibilityHint={inputHint(item.prompt)}
              value={draft}
              onChangeText={setDraft}
              editable={canAnswer && !busy}
              maxLength={ANSWER_MAX_LENGTH}
              returnKeyType="done"
              onSubmitEditing={() => void check()}
              autoComplete="off"
              importantForAutofill="no"
              {...keyboardFor(format)}
              style={[styles.input, !canAnswer ? styles.inputDone : null]}
            />
            {item.prompt.unitHint ? <Text style={styles.unit}>{item.prompt.unitHint}</Text> : null}
          </View>
        )}
        {canAnswer ? <Text style={styles.hint}>{inputHint(item.prompt)}</Text> : null}

        {notice ? (
          <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.notice}>
            {notice}
          </Text>
        ) : null}

        {shown ? <FeedbackCard feedback={shown} /> : null}

        {canAnswer ? (
          <ChildButton
            label={busy ? 'Checking…' : 'Check my answer'}
            busy={busy}
            onPress={() => void check()}
          />
        ) : (
          primaryAfterFinish
        )}

        {shown?.showHelpOptions ? (
          <View style={styles.helpBox}>
            <View style={styles.row}>
              <ChildButton
                label="Practice the method"
                secondary
                selected={helpView === 'method'}
                onPress={() => setHelp((h) => ({ ...h, [item.id]: 'method' }))}
              />
              <ChildButton
                label="Ask a grown-up"
                secondary
                selected={helpView === 'grown_up'}
                onPress={() => setHelp((h) => ({ ...h, [item.id]: 'grown_up' }))}
              />
            </View>
            {helpView === 'method' ? (
              <View accessibilityLiveRegion="polite">
                <Text accessibilityRole="header" style={styles.helpTitle}>
                  Steps to try
                </Text>
                {methodSteps(item.subjectKey).map((step, i) => (
                  <Text key={step} style={styles.body}>
                    {i + 1}. {step}
                  </Text>
                ))}
              </View>
            ) : null}
            {helpView === 'grown_up' ? (
              <Text accessibilityLiveRegion="polite" style={styles.body}>
                {ASK_GROWN_UP_COPY}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>

      <View style={styles.row}>
        {index > 0 ? (
          <ChildButton
            label="← Back"
            secondary
            accessibilityLabel="Go back to the previous question"
            onPress={() => {
              setNotice(null);
              setIndex(index - 1);
            }}
          />
        ) : null}
        {canAnswer && index + 1 < total ? (
          <ChildButton
            label="Skip for now →"
            secondary
            accessibilityLabel="Skip this question for now. You can come back to it."
            onPress={() => {
              setNotice(null);
              setIndex(index + 1);
            }}
          />
        ) : null}
      </View>
    </View>
  );
}

function FeedbackCard({ feedback }: { feedback: AnswerFeedback }) {
  const toneStyle =
    feedback.tone === 'correct'
      ? styles.toneCorrect
      : feedback.tone === 'try_again'
        ? styles.toneRetry
        : styles.toneHelp;
  return (
    <View
      accessible
      accessibilityLabel={feedback.a11yLabel}
      accessibilityLiveRegion="polite"
      style={[styles.feedback, toneStyle]}
    >
      <Text style={styles.feedbackTitle}>
        <Text accessibilityElementsHidden importantForAccessibility="no">
          {feedback.icon}{' '}
        </Text>
        {feedback.title}
      </Text>
      <Text style={styles.body}>{feedback.message}</Text>
    </View>
  );
}

function ChildButton({
  label,
  onPress,
  secondary,
  selected,
  busy,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  secondary?: boolean;
  selected?: boolean;
  busy?: boolean;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{
        disabled: busy === true,
        busy: busy === true,
        selected: selected === true,
      }}
      disabled={busy === true}
      onPress={onPress}
      style={[
        styles.button,
        secondary ? styles.secondary : null,
        selected ? styles.secondarySelected : null,
        busy ? styles.disabled : null,
      ]}
    >
      <Text style={[styles.buttonText, secondary ? styles.secondaryText : null]}>
        {selected ? `✓ ${label}` : label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.white,
    borderRadius: radii.lg,
    padding: spacing.md,
    marginVertical: spacing.sm,
  },
  celebrate: { borderWidth: 2, borderColor: colors.gold, alignItems: 'stretch' },
  celebrateTitle: {
    fontSize: typography.scale.xl,
    fontWeight: '800',
    color: colors.tealText,
    marginBottom: spacing.sm,
  },
  intro: { fontSize: typography.scale.md, color: colors.navy, marginBottom: spacing.sm },
  position: { fontSize: typography.scale.md, fontWeight: '800', color: colors.navy },
  track: {
    height: 12,
    borderRadius: radii.pill,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.muted,
    overflow: 'hidden',
    marginVertical: spacing.sm,
  },
  fill: { height: '100%', backgroundColor: colors.teal },
  topic: { fontSize: typography.scale.sm, color: colors.muted, fontWeight: '800' },
  passage: {
    backgroundColor: colors.offWhite,
    borderRadius: radii.md,
    padding: spacing.md,
    marginVertical: spacing.sm,
  },
  passageTitle: { fontSize: typography.scale.lg, fontWeight: '800', color: colors.navy },
  prompt: {
    fontSize: typography.scale.xl,
    fontWeight: '800',
    color: colors.navy,
    marginVertical: spacing.md,
  },
  body: { fontSize: typography.scale.lg, color: colors.navy, marginVertical: spacing.xs },
  hint: { fontSize: typography.scale.md, color: colors.muted, marginTop: spacing.xs },
  answerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  input: {
    flex: 1,
    minHeight: CHILD_TOUCH,
    borderWidth: 2,
    borderColor: colors.teal,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    fontSize: typography.scale.xl,
    color: colors.navy,
    backgroundColor: colors.white,
  },
  inputDone: { borderColor: colors.muted, backgroundColor: colors.offWhite },
  unit: { fontSize: typography.scale.lg, fontWeight: '800', color: colors.navy },
  choice: {
    minHeight: CHILD_TOUCH,
    borderRadius: radii.md,
    borderWidth: 2,
    borderColor: colors.teal,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginVertical: spacing.xs,
  },
  choiceSelected: { backgroundColor: colors.teal },
  choiceText: { fontSize: typography.scale.lg, fontWeight: '800', color: colors.tealText },
  choiceTextSelected: { color: colors.white },
  notice: {
    fontSize: typography.scale.md,
    color: colors.navy,
    borderLeftWidth: 4,
    borderLeftColor: colors.gold,
    paddingLeft: spacing.sm,
    marginTop: spacing.sm,
  },
  feedback: {
    borderRadius: radii.md,
    borderLeftWidth: 6,
    padding: spacing.md,
    marginTop: spacing.md,
    backgroundColor: colors.offWhite,
  },
  toneCorrect: { borderLeftColor: colors.success },
  toneRetry: { borderLeftColor: colors.gold },
  toneHelp: { borderLeftColor: colors.teal },
  feedbackTitle: { fontSize: typography.scale.xl, fontWeight: '800', color: colors.navy },
  helpBox: { marginTop: spacing.sm },
  helpTitle: {
    fontSize: typography.scale.lg,
    fontWeight: '800',
    color: colors.navy,
    marginTop: spacing.sm,
  },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  button: {
    minHeight: CHILD_TOUCH,
    borderRadius: radii.pill,
    backgroundColor: colors.teal,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    marginVertical: spacing.xs,
  },
  secondary: { backgroundColor: colors.white, borderWidth: 2, borderColor: colors.teal },
  secondarySelected: { backgroundColor: colors.offWhite },
  disabled: { opacity: 0.55 },
  buttonText: { color: colors.white, fontSize: typography.scale.lg, fontWeight: '800' },
  secondaryText: { color: colors.tealText },
});
