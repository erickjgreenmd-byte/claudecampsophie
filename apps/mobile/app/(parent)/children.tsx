import { useCallback, useState } from 'react';
import { Text, TextInput } from 'react-native';
import { router } from 'expo-router';
import {
  AGE_BANDS,
  childActivationResponseSchema,
  createChildProfileResponseSchema,
  familyOverviewResponseSchema,
  type AgeBand,
} from '@pencillift/contracts';
import type { ApiClient } from '@pencillift/contracts/client';
import { colors } from '@pencillift/ui-tokens';
import {
  activationError,
  activationMessage,
  childRows,
  gradeText,
  parentActionError,
  slotSummary,
  type ChildRow,
} from '../../src/family/family-view.ts';
import {
  Body,
  Button,
  Card,
  Choice,
  ErrorBox,
  Heading,
  Loading,
  ParentAccessState,
  Screen,
  styles,
  Title,
  useLoad,
  useParentAccess,
} from '../../src/family/ui.tsx';

/**
 * Children (spec P3, P11, P14 child list + add-child/paid-slot management; AC_ACCESS_04,
 * AC_CAPACITY_03). New children are free drafts; a draft takes one of the family's unused paid
 * slots without a new purchase, and only an active child (holding a paid slot) can be paired.
 * Buying another slot happens on the Plan and child slots screen, never here.
 */
export default function ChildrenScreen() {
  const access = useParentAccess();
  return (
    <Screen>
      <Title>Children</Title>
      <ParentAccessState access={access} />
      {access.status === 'ready' ? <ChildrenContent api={access.api} /> : null}
    </Screen>
  );
}

function ChildrenContent({ api }: { api: ApiClient }) {
  const load = useCallback(() => api.get('/v1/family', familyOverviewResponseSchema), [api]);
  const { state, reload } = useLoad(load);

  if (state.status === 'idle' || state.status === 'loading') {
    return <Loading label="Loading children" />;
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
  const family = state.data;
  return (
    <>
      <Card>
        <Body>{slotSummary(family)}</Body>
        <Button
          label="Plan and child slots"
          secondary
          onPress={() => router.push('/(parent)/plan')}
        />
      </Card>
      {family.children.length === 0 ? (
        <Body>No children yet. Add your first child below.</Body>
      ) : null}
      {childRows(family).map((row) => (
        <ChildCard key={row.id} api={api} row={row} onChanged={() => void reload()} />
      ))}
      <AddChild api={api} onAdded={() => void reload()} />
    </>
  );
}

/**
 * One child. A draft with an unused paid slot available can take it here (no purchase; the server
 * re-checks slots, consent and the PIN unlock). The outcome stays visible after the list reloads.
 */
function ChildCard({
  api,
  row,
  onChanged,
}: {
  api: ApiClient;
  row: ChildRow;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; needsPin: boolean; text: string } | null>(
    null,
  );

  const activate = async () => {
    if (busy) return;
    setBusy(true);
    setResult(null);
    try {
      const activated = await api.send(
        'POST',
        `/v1/children/${row.id}/activate`,
        undefined,
        childActivationResponseSchema,
      );
      setResult({ ok: true, needsPin: false, text: activationMessage(row.nickname, activated) });
      onChanged();
    } catch (error) {
      const mapped = activationError(error);
      setResult({ ok: false, needsPin: mapped.needsPin, text: mapped.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Heading>{row.nickname}</Heading>
      <Body>{row.detail}</Body>
      <Body muted>Status: {row.statusText}</Body>
      {row.canPair ? (
        <Button
          label="Pair a device"
          accessibilityLabel={`Pair a device for ${row.nickname}`}
          onPress={() =>
            router.push({
              pathname: '/(parent)/pair-device',
              params: { childId: row.id, nickname: row.nickname },
            })
          }
        />
      ) : row.pairingNote ? (
        <Body muted>{row.pairingNote}</Body>
      ) : null}
      {row.canActivate ? (
        <Button
          label={busy ? 'Assigning…' : 'Assign an unused paid slot'}
          accessibilityLabel={`Assign an unused paid slot to ${row.nickname}`}
          busy={busy}
          onPress={() => void activate()}
        />
      ) : row.activationNote ? (
        <Body muted>{row.activationNote}</Body>
      ) : null}
      {result ? (
        result.ok ? (
          <Body>{result.text}</Body>
        ) : (
          <ErrorBox message={result.text} needsPin={result.needsPin} />
        )
      ) : null}
    </Card>
  );
}

const GRADE_OPTIONS = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((g) => ({
  value: String(g),
  label: g === 0 ? 'K' : String(g),
}));
const AGE_OPTIONS = AGE_BANDS.map((band) => ({ value: band, label: band }));

function AddChild({ api, onAdded }: { api: ApiClient; onAdded: () => void }) {
  const [nickname, setNickname] = useState('');
  const [grade, setGrade] = useState('3');
  const [ageBand, setAgeBand] = useState<AgeBand>('8-10');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; needsPin: boolean; text: string } | null>(
    null,
  );

  const submit = async () => {
    const name = nickname.trim();
    if (name.length < 1 || name.length > 40) {
      setResult({ ok: false, needsPin: false, text: 'Enter a nickname of 1 to 40 characters.' });
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      await api.send(
        'POST',
        '/v1/children',
        { nickname: name, gradeLevel: Number(grade), ageBand },
        createChildProfileResponseSchema,
      );
      setNickname('');
      setResult({ ok: true, needsPin: false, text: `${name} was added as a draft profile.` });
      onAdded();
    } catch (error) {
      const mapped = parentActionError(error);
      setResult({ ok: false, needsPin: mapped.needsPin, text: mapped.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Heading>Add a child</Heading>
      <Body muted>Use a nickname. PencilLift doesn’t need a birth date, school or email.</Body>
      <Text style={styles.label} nativeID="nicknameLabel">
        Nickname
      </Text>
      <TextInput
        accessibilityLabel="Nickname"
        accessibilityLabelledBy="nicknameLabel"
        style={styles.input}
        value={nickname}
        maxLength={40}
        autoCorrect={false}
        onChangeText={setNickname}
        placeholderTextColor={colors.muted}
      />
      <Choice
        label={`Grade (${gradeText(Number(grade))})`}
        options={GRADE_OPTIONS}
        value={grade}
        onChange={setGrade}
      />
      <Choice label="Age band" options={AGE_OPTIONS} value={ageBand} onChange={setAgeBand} />
      <Button
        label={busy ? 'Adding…' : 'Add draft child'}
        busy={busy}
        onPress={() => void submit()}
      />
      {result ? (
        result.ok ? (
          <Body>{result.text}</Body>
        ) : (
          <ErrorBox message={result.text} needsPin={result.needsPin} />
        )
      ) : null}
    </Card>
  );
}
