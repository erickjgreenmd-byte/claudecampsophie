import { useCallback, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import {
  IDENTITY_SCREEN_COPY,
  identityVerificationStatusSchema,
  type IdentityVerificationStatus,
} from '@pencillift/contracts';
import type { ApiClient } from '@pencillift/contracts/client';
import { colors, spacing, typography } from '@pencillift/ui-tokens';
import {
  Body,
  Button,
  Card,
  Checkbox,
  ErrorBox,
  Heading,
  Loading,
  Notice,
  ParentAccessState,
  Screen,
  styles as ui,
  Title,
  useLoad,
  useParentAccess,
} from '../../src/family/ui.tsx';
import { clearIdentityProblem } from '@pencillift/contracts';
import {
  emptyIdentityForm,
  IDENTITY_PHONE_COPY,
  identityDocumentFromAsset,
  identityRequestProblem,
  identityView,
  submitIdentityForm,
  type IdentityFormState,
} from '../../src/identity/identity-form.ts';

/**
 * The adult ID check on the phone (spec P3 verifiable parental consent, AC_ACCESS_01/02; migration
 * 0990). One government photo ID, the adult's own date of birth checked AGAINST it, and the legal
 * declaration that binds the document to the person. NO SELFIE, ever: nothing compares one, so
 * asking for a face photo would carry the biometric exposure without the verification.
 *
 * expo-router: this file IS the route `/(parent)/identity`, so nothing registers it — unlike the
 * portal, whose page needs a line in `apps/web/src/routes.tsx`.
 *
 * THIS FILE DECIDES NOTHING AND WORDS NOTHING. Every sentence and every branch comes from
 * `src/identity/identity-form.ts`, which takes them from `@pencillift/contracts` — the portal's
 * source too. That is not tidiness: this project's vitest cannot render react-native, so a rule
 * written here could not be tested at all, and that is how the phone's per-field edit rule went
 * unfixed for three rounds while the portal's was pinned (L-070, BUG-404..407). Anything you are
 * tempted to add here — a message, a condition, a label — belongs in identity-form.ts, where
 * identity-form.test.ts can hold it.
 *
 * The photo never reaches storage: the picker hands over base64, `submitIdentityForm` puts it in the
 * request body, and this screen holds it in component state until then.
 */
export default function IdentityScreen() {
  const access = useParentAccess();
  return (
    <Screen>
      <ParentAccessState access={access} />
      {access.status === 'ready' ? <IdentityCheck api={access.api} /> : null}
    </Screen>
  );
}

/** The picker's options for both sources. `base64` because the bytes travel in the request body. */
const PICKER_OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: ['images'],
  allowsMultipleSelection: false,
  base64: true,
  // No location or device metadata rides along with an adult's ID.
  exif: false,
  quality: 0.85,
};

function IdentityCheck({ api }: { api: ApiClient }) {
  const load = useCallback(
    () => api.get('/v1/identity/verification', identityVerificationStatusSchema),
    [api],
  );
  const { state, reload } = useLoad(load);
  /** The answer the SERVER last gave: the GET's, until a POST supersedes it. */
  const [submitted, setSubmitted] = useState<IdentityVerificationStatus | null>(null);
  const [form, setForm] = useState<IdentityFormState>(emptyIdentityForm);
  const [transportProblem, setTransportProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Replaces whatever stopped a photo being added, and keeps no photo that cannot be sent. */
  const setDocumentProblem = (message: string) => {
    setForm((current) => ({
      ...current,
      document: null,
      problems: [
        ...clearIdentityProblem(current.problems, 'document'),
        { field: 'document', message },
      ],
    }));
  };

  const addPhoto = async (source: 'camera' | 'library') => {
    setTransportProblem(null);
    const permission =
      source === 'camera'
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setDocumentProblem(
        source === 'camera' ? IDENTITY_PHONE_COPY.cameraDenied : IDENTITY_PHONE_COPY.libraryDenied,
      );
      return;
    }
    const result =
      source === 'camera'
        ? await ImagePicker.launchCameraAsync(PICKER_OPTIONS)
        : await ImagePicker.launchImageLibraryAsync(PICKER_OPTIONS);
    if (result.canceled) return;
    const asset = result.assets[0];
    const read = identityDocumentFromAsset({
      base64: asset?.base64 ?? null,
      mimeType: asset?.mimeType ?? null,
    });
    if ('rejection' in read) {
      setDocumentProblem(read.rejection);
      return;
    }
    setForm((current) => ({
      ...current,
      document: read.document,
      problems: clearIdentityProblem(current.problems, 'document'),
    }));
  };

  const submit = async () => {
    if (busy) return;
    setTransportProblem(null);
    setBusy(true);
    try {
      // Enforcement lives in submitIdentityForm, on submit, reporting EVERY unmet requirement at
      // once. The button below is disabled only while this is in flight, never to express a rule
      // (L-059: a disabled control is not a rule, it is the absence of a way to break one).
      const result = await submitIdentityForm(form, (body) =>
        api.send('POST', '/v1/identity/verification', body, identityVerificationStatusSchema),
      );
      if (result.kind === 'unmet') {
        setForm((current) => ({ ...current, problems: result.problems }));
        return;
      }
      if (result.kind === 'failed') {
        setTransportProblem(result.message);
        return;
      }
      // What the DATABASE decided, not what this screen hoped for: `adult_declared` is generated.
      setSubmitted(result.status);
      setForm((current) => ({
        ...current,
        document: null,
        declarationAffirmed: false,
        problems: [],
      }));
    } finally {
      setBusy(false);
    }
  };

  if (state.status === 'idle' || state.status === 'loading') {
    return <Loading label={IDENTITY_SCREEN_COPY.loadingLabel} />;
  }
  if (state.status === 'error') {
    // The same sentence the portal prints for the same failure, via the same contract helper.
    return <ErrorBox message={identityRequestProblem(state.error)} onRetry={() => void reload()} />;
  }

  const view = identityView({ form, status: submitted ?? state.data, busy, transportProblem });
  if (view.body.kind === 'established') {
    return (
      <>
        <Title>{view.title}</Title>
        <Card>
          <Heading>{view.body.headline}</Heading>
          <Body>{view.body.detail}</Body>
          <Body muted>{view.faceCheckNote}</Body>
        </Card>
      </>
    );
  }
  if (view.body.kind === 'blocked') {
    return (
      <>
        <Title>{view.title}</Title>
        <Notice alert>
          <Body>{view.body.message}</Body>
          <Button label={view.body.supportLabel} onPress={() => router.push('/(parent)/support')} />
        </Notice>
        <Body muted>{view.faceCheckNote}</Body>
      </>
    );
  }
  const { fields } = view.body;
  return (
    <>
      <Title>{view.title}</Title>
      <Card>
        <Body>{view.method}</Body>
        <Body muted>{view.notStored}</Body>
        <Body muted>{view.faceCheckNote}</Body>
      </Card>
      {view.body.refusal !== null ? <ErrorBox message={view.body.refusal} /> : null}
      {view.body.transportProblem !== null ? (
        <Notice alert>
          <Body>{view.body.transportProblem}</Body>
        </Notice>
      ) : null}
      <Card>
        <Heading>{fields.documentLabel}</Heading>
        <Body muted>{fields.documentHint}</Body>
        <Body>{fields.documentStatus}</Body>
        <View style={local.row}>
          <Button label={fields.addFromCameraLabel} onPress={() => void addPhoto('camera')} />
          <Button
            label={fields.addFromLibraryLabel}
            secondary
            onPress={() => void addPhoto('library')}
          />
        </View>
        {fields.documentProblem !== null ? (
          <Text accessibilityRole="alert" style={local.problem}>
            {fields.documentProblem}
          </Text>
        ) : null}
      </Card>
      <Card>
        <Text style={ui.label} nativeID="identityDobLabel">
          {fields.dateOfBirthLabel}
        </Text>
        <Body muted>{fields.dateOfBirthHint}</Body>
        <TextInput
          accessibilityLabel={fields.dateOfBirthLabel}
          accessibilityLabelledBy="identityDobLabel"
          style={ui.input}
          value={form.dateOfBirth}
          // A text field with a numeric keypad, not a native date wheel: the parent is copying a
          // printed date off a licence, and a spinner that opens on today is a longer journey to
          // 1990 than typing it.
          keyboardType="numbers-and-punctuation"
          autoCorrect={false}
          autoCapitalize="none"
          maxLength={10}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={colors.muted}
          onChangeText={(text) =>
            setForm((current) => ({
              ...current,
              dateOfBirth: text,
              // The reason for THIS field goes the moment it is retyped; the others are still unmet
              // and still say so (L-059). Neither surface did this until the rule was shared.
              problems: clearIdentityProblem(current.problems, 'dateOfBirth'),
            }))
          }
        />
        {fields.dateOfBirthProblem !== null ? (
          <Text accessibilityRole="alert" style={local.problem}>
            {fields.dateOfBirthProblem}
          </Text>
        ) : null}
      </Card>
      <Card>
        <Heading>{fields.declarationLabel}</Heading>
        {/* The declaration in full, as the label of the control that affirms it: a statement being
            made, not a tick box, and not a summary of one. */}
        <Checkbox
          label={fields.declarationStatement}
          checked={form.declarationAffirmed}
          error={fields.declarationProblem}
          onChange={(next) =>
            setForm((current) => ({
              ...current,
              declarationAffirmed: next,
              problems: clearIdentityProblem(current.problems, 'declaration'),
            }))
          }
        />
      </Card>
      <Button
        label={view.body.submitLabel}
        busy={view.body.submitDisabled}
        onPress={() => void submit()}
      />
    </>
  );
}

const local = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  problem: { color: colors.danger, fontSize: typography.scale.md, marginTop: spacing.xs },
});
