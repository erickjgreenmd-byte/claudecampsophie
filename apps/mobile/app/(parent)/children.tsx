import { useCallback, useState } from 'react';
import { Text, TextInput } from 'react-native';
import { router } from 'expo-router';
import {
  GRADE_LEVEL_MAX,
  ageBandSchema,
  childActivationResponseSchema,
  childArchiveResponseSchema,
  createChildProfileResponseSchema,
  familyOverviewResponseSchema,
  updateChildProfileResponseSchema,
  type AgeBand,
  type FamilyChild,
  type UpdateChildProfileRequest,
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
  Notice,
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
      {childRows(family).map((row, index) => (
        <ChildCard
          key={row.id}
          api={api}
          row={row}
          child={family.children[index]!}
          onChanged={() => void reload()}
        />
      ))}
      <AddChild api={api} onAdded={() => void reload()} />
    </>
  );
}

/**
 * The grades and age bands the contract allows, read from the contract itself (L-036): the bands
 * come from the enum's `.options` and the grades from GRADE_LEVEL_MAX, so widening the launch scope
 * in packages/contracts/src/family.ts reaches these menus without a second edit here.
 */
const GRADE_OPTIONS = Array.from({ length: GRADE_LEVEL_MAX + 1 }, (_, g) => ({
  value: String(g),
  label: g === 0 ? 'K' : String(g),
}));
const AGE_OPTIONS = ageBandSchema.options.map((band) => ({ value: band, label: band }));

/**
 * One child. A draft with an unused paid slot available can take it here (no purchase; the server
 * re-checks slots, consent and the PIN unlock). The outcome stays visible after the list reloads.
 */
function ChildCard({
  api,
  row,
  child,
  onChanged,
}: {
  api: ApiClient;
  row: ChildRow;
  /** The same profile as `row`, for the fields the row view model doesn't carry. */
  child: FamilyChild;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; needsPin: boolean; text: string } | null>(
    null,
  );
  const [editing, setEditing] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  /** A child whose data deletion is open is read-only here (API-AUTH-R2-02); see the notice below. */
  const deletionPending = child.deletionPending === true;

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

  /**
   * WEB-R2-03: archiving frees the paid slot and signs the child's devices out while every scan,
   * point and reward is kept (spec P11, AC_CAPACITY_08). The route existed with no caller anywhere,
   * yet the Plan screen tells parents to "archive them in Children".
   */
  const archive = async () => {
    if (busy) return;
    setBusy(true);
    setResult(null);
    try {
      const archived = await api.send(
        'POST',
        `/v1/children/${row.id}/archive`,
        undefined,
        childArchiveResponseSchema,
      );
      setConfirmArchive(false);
      setResult({
        ok: true,
        needsPin: false,
        text: `${row.nickname} is archived. Their history is kept, and ${archived.assignedSlots} of ${archived.paidSlots} paid slots are now in use. ${archived.note}`,
      });
      onChanged();
    } catch (error) {
      const mapped = parentActionError(error);
      setResult({ ok: false, needsPin: mapped.needsPin, text: mapped.message });
    } finally {
      setBusy(false);
    }
  };

  /** WEB-R2-03: the saved grade is what new practice is built for, so it must be correctable. */
  const saveProfile = async (body: UpdateChildProfileRequest) => {
    if (busy) return;
    setBusy(true);
    setResult(null);
    try {
      const saved = await api.send(
        'PATCH',
        `/v1/children/${row.id}`,
        body,
        updateChildProfileResponseSchema,
      );
      setEditing(false);
      setResult({
        ok: true,
        needsPin: false,
        text: `Saved. ${saved.child.nickname} is in ${gradeText(saved.child.gradeLevel).toLowerCase()}, ages ${saved.child.ageBand}.`,
      });
      onChanged();
    } catch (error) {
      const mapped = parentActionError(error);
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
      {deletionPending ? (
        // API-AUTH-R2-02: a child under an open deletion request stays listed so the parent can see
        // who the request covers, but the server refuses pairing, activation and edits for them, so
        // this screen offers no control either.
        <Notice>
          <Body>
            Data deletion under way. You asked for {row.nickname}’s data to be deleted, so nothing
            can be changed, paired or activated for them. Cancel the request under Privacy if you
            did not mean it.
          </Body>
        </Notice>
      ) : null}
      {deletionPending ? null : row.canPair ? (
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
      {deletionPending ? null : row.canActivate ? (
        <Button
          label={busy ? 'Assigning…' : 'Assign an unused paid slot'}
          accessibilityLabel={`Assign an unused paid slot to ${row.nickname}`}
          busy={busy}
          onPress={() => void activate()}
        />
      ) : row.activationNote ? (
        <Body muted>{row.activationNote}</Body>
      ) : null}
      {child.status === 'archived' || deletionPending ? null : (
        <>
          <Button
            label={editing ? 'Cancel edit' : 'Edit profile'}
            accessibilityLabel={`Edit ${row.nickname}’s details`}
            secondary
            disabled={busy}
            onPress={() => setEditing((open) => !open)}
          />
          {editing ? (
            <EditChild child={child} busy={busy} onSave={(body) => void saveProfile(body)} />
          ) : null}
          {confirmArchive ? (
            <Notice>
              <Body>
                Archive {row.nickname}? Their homework, practice, points and rewards are all kept
                and stay readable.{' '}
                {child.status === 'active'
                  ? 'Their paid slot is freed for another child, and their paired devices are signed out.'
                  : 'Their paired devices are signed out.'}{' '}
                You can activate them again later while a paid slot is free. Your store subscription
                is unchanged — change the plan in the store to lower the price.
              </Body>
              <Button
                label={busy ? 'Archiving…' : `Yes, archive ${row.nickname}`}
                busy={busy}
                onPress={() => void archive()}
              />
              <Button
                label={`Keep ${row.nickname} as they are`}
                secondary
                disabled={busy}
                onPress={() => setConfirmArchive(false)}
              />
            </Notice>
          ) : (
            <Button
              label="Archive (keeps history, frees the slot)"
              accessibilityLabel={`Archive ${row.nickname}`}
              secondary
              disabled={busy}
              onPress={() => setConfirmArchive(true)}
            />
          )}
        </>
      )}
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

/**
 * Correcting one child's nickname, grade and age band (WEB-R2-03). The menus come from the contract
 * (L-036), so widening the launch scope in packages/contracts reaches this screen with no second
 * edit. The server re-checks the recent PIN unlock, the contract bounds and the archived rule.
 */
function EditChild({
  child,
  busy,
  onSave,
}: {
  child: FamilyChild;
  busy: boolean;
  onSave: (body: UpdateChildProfileRequest) => void;
}) {
  const [nickname, setNickname] = useState(child.nickname);
  const [grade, setGrade] = useState(String(child.gradeLevel));
  const [ageBand, setAgeBand] = useState<AgeBand>(child.ageBand);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const submit = () => {
    const name = nickname.trim();
    if (name.length < 1 || name.length > 40) {
      setFieldError('Enter a nickname of 1 to 40 characters.');
      return;
    }
    setFieldError(null);
    onSave({ nickname: name, gradeLevel: Number(grade), ageBand });
  };

  return (
    <>
      <Text style={styles.label} nativeID={`editNickname-${child.id}`}>
        Nickname
      </Text>
      <TextInput
        accessibilityLabel={`Nickname for ${child.nickname}`}
        accessibilityLabelledBy={`editNickname-${child.id}`}
        style={styles.input}
        value={nickname}
        maxLength={40}
        autoCorrect={false}
        onChangeText={(text) => {
          setNickname(text);
          setFieldError(null);
        }}
        placeholderTextColor={colors.muted}
      />
      <Choice
        label={`Grade (${gradeText(Number(grade))})`}
        options={GRADE_OPTIONS}
        value={grade}
        onChange={setGrade}
      />
      <Choice label="Age band" options={AGE_OPTIONS} value={ageBand} onChange={setAgeBand} />
      <Body muted>
        New practice is built for the grade saved here, so update it each school year.
      </Body>
      {fieldError ? <ErrorBox message={fieldError} /> : null}
      <Button
        label={busy ? 'Saving…' : `Save ${child.nickname}’s details`}
        busy={busy}
        onPress={submit}
      />
    </>
  );
}

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
