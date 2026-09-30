import { useCallback, useState } from 'react';
import { Text, TextInput } from 'react-native';
import { router } from 'expo-router';
import {
  ATTESTATION_REQUIRED_COPY,
  CONSENT_ATTESTATION_STATEMENT,
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
  childArchiveLabel,
  childEditBody,
  childEditDriftNote,
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
  Checkbox,
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
        //
        // The wording is the web client's (apps/web/src/pages/app/ChildrenPage.tsx), so the two
        // surfaces say the same thing about the same flag; the web's two inline links are the two
        // buttons below, which is the only difference. MOB-R4-LOCK-06 rewrote it here to
        // hedge the scope, because `deletionPending` covers a whole-family request too (GET
        // /v1/family: `d.scope = 'family' or d.target_child_id = c.id`). That hedge named a state
        // this screen cannot reach (HUNT5-H-3): a family-scope request revokes every adult membership
        // with the family tombstone, so currentFamilyId() answers NOT_FOUND and this screen renders
        // its no-family notice instead of any child card — while it ALSO ended by promising that
        // Privacy "cancels it if you did not mean it" (HUNT5-H-2), and there is no cancel anywhere:
        // /v1/privacy has only POST and GET /deletion, nothing marks a request cancelled, and the
        // purge is enqueued with the request. Support is where a mistake is actually handled.
        //
        // HUNT6-I-3: the rewrite that removed the hedge then said "You asked for …", which the flag
        // cannot establish. GET /v1/family computes `deletionPending` from the request's scope and
        // target alone and never exposes deletion_requests.requested_by, any guardian may delete a
        // child's data, and a child-scope request leaves every other membership active — so the
        // family's other adult is served the same flag and was told they had asked for it. The
        // sentence is true of whoever is reading it now.
        <Notice>
          <Body>
            Data deletion under way. A deletion request covering {row.nickname}’s data is open.
            Processing has already stopped, so nothing can be changed, paired or activated for them,
            and they stay listed here until the deletion finishes. Deletion can’t be undone from the
            app: if you did not mean it, contact support straight away.
          </Body>
          <Button
            label="Privacy and data"
            secondary
            onPress={() => router.push('/(parent)/privacy')}
          />
          <Button
            label="Contact support"
            secondary
            onPress={() => router.push('/(parent)/support')}
          />
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
              // HUNT7-G-4 (WEBR4-12, the mobile half): this row is rendered for a DRAFT child too,
              // and a draft holds no slot, so archiving one frees nothing — `slotSummary` returns
              // unchanged counts after it. The confirmation body above already branched on the
              // status; the label did not. The portal's card has branched since round 4
              // (apps/web/src/pages/app/ChildrenPage.tsx, ChildCard's archive button), and the two
              // labels now come from one helper so they cannot drift apart again.
              label={childArchiveLabel(child.status)}
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
 * edit. Only the fields the parent edited here are sent, so a concurrent edit by the other guardian
 * is not overwritten wholesale. The server re-checks the recent PIN unlock, the contract bounds and
 * the archived rule.
 *
 * HUNT7-G-4: that promise used to be false on this surface. The fields were seeded from the live prop
 * once and all three were then PATCHed unconditionally from that seed — and the card above is keyed on
 * `row.id` (ChildrenContent), so a reload never remounts it and the seed is as old as the open form.
 * Guardian B moved the child up a grade on the portal while parent A had this form open on the old
 * grade; A fixed a typo in the nickname and the PATCH put the grade back, which is the value new
 * practice is built for. That is BUG-222/WEBR4-03 verbatim — fixed on the portal in round 4, again in
 * round 5 (HUNT5-F-1) and again in round 6 (HUNT6-G-8), every time inside apps/web only.
 *
 * What travels now is decided by `touched` and built by `childEditBody`
 * (src/family/family-view.ts), where it can be tested: this app's suite cannot render react-native
 * (vitest.config.ts), so a rule living inside this component could not be pinned at all. The fields
 * are NOT reseeded from the live prop — that is the loss HUNT5-F-1 was filed for — so
 * `childEditDriftNote` names what moved under the open form instead (BUG-330), saying WHAT changed
 * and not WHO changed it, because the response carries no actor (HUNT7-G-2).
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
  /**
   * The profile this form was opened on, captured once (HUNT5-F-1). The fields below are seeded from
   * this and never reseeded, so a reload cannot move them under the parent's hands. `child` — the
   * live prop this screen's reload refreshes under the open form — is read only to name what changed
   * and to address the parent; it never decides what travels.
   */
  const [seed] = useState(child);
  const [nickname, setNickname] = useState(seed.nickname);
  const [grade, setGrade] = useState(String(seed.gradeLevel));
  const [ageBand, setAgeBand] = useState<AgeBand>(seed.ageBand);
  const [fieldError, setFieldError] = useState<string | null>(null);
  /**
   * Which fields the parent has edited in THIS form, the portal's rule (HUNT6-G-8, BUG-330). "Edited"
   * and not "differs from the seed": those two agree until a concurrent change lands, and after it a
   * seed diff makes the value the parent can SEE unsavable, with nothing on screen saying why.
   *
   * `Choice` (src/family/ui.tsx) calls onChange for a press on the ALREADY selected chip, so tapping
   * the grade the form is showing marks it edited and sends it. That is deliberate here and it is
   * where this form is not identical to the portal's, whose `<select>` fires no change for the option
   * already chosen: a press is an explicit act on that field, and re-asserting the value on screen is
   * exactly the dead end BUG-330 was filed for. It cannot revert anything the parent has not touched.
   */
  const [touched, setTouched] = useState({ nickname: false, gradeLevel: false, ageBand: false });

  /** Only the fields the parent edited here (WEBR4-03, HUNT5-F-1, HUNT6-G-8, HUNT7-G-4). */
  const changes = (name: string) =>
    childEditBody({ nickname: name, gradeLevel: Number(grade), ageBand }, touched);
  const nothingEdited = Object.keys(changes(nickname.trim())).length === 0;
  /** What moved under this form since it opened, for the notice below. */
  const drift = childEditDriftNote(seed, child);

  const submit = () => {
    const name = nickname.trim();
    if (name.length < 1 || name.length > 40) {
      setFieldError('Enter a nickname of 1 to 40 characters.');
      return;
    }
    setFieldError(null);
    const body = changes(name);
    // The contract's refine rejects an empty body anyway; Save is already off in this state.
    if (Object.keys(body).length === 0) return;
    onSave(body);
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
          setTouched((t) => ({ ...t, nickname: true }));
          setFieldError(null);
        }}
        placeholderTextColor={colors.muted}
      />
      <Choice
        label={`Grade (${gradeText(Number(grade))})`}
        options={GRADE_OPTIONS}
        value={grade}
        onChange={(value) => {
          setGrade(value);
          setTouched((t) => ({ ...t, gradeLevel: true }));
        }}
      />
      <Choice
        label="Age band"
        options={AGE_OPTIONS}
        value={ageBand}
        onChange={(value) => {
          setAgeBand(value);
          setTouched((t) => ({ ...t, ageBand: true }));
        }}
      />
      <Body muted>
        New practice is built for the grade saved here, so update it each school year.
      </Body>
      {drift ? (
        <Notice>
          <Body>{drift}</Body>
        </Notice>
      ) : null}
      {fieldError ? <ErrorBox message={fieldError} /> : null}
      <Button
        label={busy ? 'Saving…' : `Save ${child.nickname}’s details`}
        busy={busy}
        disabled={nothingEdited}
        onPress={submit}
      />
    </>
  );
}

function AddChild({ api, onAdded }: { api: ApiClient; onAdded: () => void }) {
  const [nickname, setNickname] = useState('');
  const [grade, setGrade] = useState('3');
  const [ageBand, setAgeBand] = useState<AgeBand>('8-10');
  // The parental/guardian attestation for THIS child (migration 0970), worded identically to the
  // portal's box so the two surfaces ask for the same thing (L-037).
  const [attested, setAttested] = useState(false);
  const [attestError, setAttestError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; needsPin: boolean; text: string } | null>(
    null,
  );

  const submit = async () => {
    const name = nickname.trim();
    const badNickname = name.length < 1 || name.length > 40;
    // Both reasons are reported in one pass, so fixing one does not earn a second refusal.
    setAttestError(attested ? null : ATTESTATION_REQUIRED_COPY);
    if (badNickname) {
      setResult({ ok: false, needsPin: false, text: 'Enter a nickname of 1 to 40 characters.' });
      return;
    }
    if (!attested) {
      setResult(null);
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      await api.send(
        'POST',
        '/v1/children',
        { nickname: name, gradeLevel: Number(grade), ageBand, parentalAttestation: true },
        createChildProfileResponseSchema,
      );
      setNickname('');
      // The statement covers one child, so the tick must not carry over to a sibling.
      setAttested(false);
      setAttestError(null);
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
      <Checkbox
        label={CONSENT_ATTESTATION_STATEMENT}
        checked={attested}
        error={attestError}
        onChange={(next) => {
          setAttested(next);
          setAttestError(null);
        }}
      />
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
