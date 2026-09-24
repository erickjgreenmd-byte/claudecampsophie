import { useCallback, useState } from 'react';
import { Text, TextInput } from 'react-native';
import { router } from 'expo-router';
import {
  AGE_BANDS,
  createChildProfileResponseSchema,
  familyOverviewResponseSchema,
  type AgeBand,
} from '@pencillift/contracts';
import type { ApiClient } from '@pencillift/contracts/client';
import { colors } from '@pencillift/ui-tokens';
import {
  childRows,
  gradeText,
  parentActionError,
  slotSummary,
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
 * Children (spec P3, P14 child list + add-child; AC_ACCESS_04). New children are free drafts;
 * only an active child (holding a paid slot) can be paired with a device.
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
        <Body muted>
          Assigning a paid slot to a draft happens in subscription management, which isn’t available
          on this screen yet.
        </Body>
      </Card>
      {family.children.length === 0 ? (
        <Body>No children yet. Add your first child below.</Body>
      ) : null}
      {childRows(family).map((row) => (
        <Card key={row.id}>
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
        </Card>
      ))}
      <AddChild api={api} onAdded={() => void reload()} />
    </>
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
