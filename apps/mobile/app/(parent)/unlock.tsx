import { useEffect, useState } from 'react';
import { Switch, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { colors } from '@pencillift/ui-tokens';
import { enterParentMode } from '../../src/lib/mode.ts';
import { parentAuth, portalUrl } from '../../src/lib/parent-auth.ts';
import { secureStorage } from '../../src/lib/secure-storage.ts';
import {
  biometricPinStore,
  biometricsSupported,
  modeEffects,
  stepUpApi,
} from '../../src/family/runtime.ts';
import {
  Body,
  Button,
  Card,
  ErrorBox,
  Heading,
  Notice,
  Screen,
  SignInPrompt,
  SignOutButton,
  styles,
  Title,
  useRelockOnBackground,
  GatedButton,
  openExternalUrl,
} from '../../src/family/ui.tsx';
import {
  lockParentArea,
  pinResetGuidance,
  unlockWithBiometrics,
  unlockWithPin,
  type UnlockOutcome,
} from '../../src/family/unlock.ts';

/**
 * Parent-area unlock (spec P3; AC_ACCESS_07/08). Every unlock is a fresh, server-verified PIN
 * (rate-limited, with lockout). Biometric unlock is an opt-in convenience that reads the PIN from
 * the keychain behind the OS prompt; the server still verifies it. The unlock is short-lived.
 * Without a signed-in parent, a configured build offers the sign-in here (MOB-R1-08); only a build
 * with no parent sign-in at all says so.
 */
export default function UnlockScreen() {
  const [api, setApi] = useState(() => stepUpApi());
  // The step-up client appears once the session layer registers a signed-in parent.
  useEffect(() => parentAuth.watch(() => setApi(stepUpApi())), []);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [biometricOn, setBiometricOn] = useState(false);
  const [rememberBiometric, setRememberBiometric] = useState(false);
  const canBiometric = biometricsSupported();
  useRelockOnBackground(api);

  useEffect(() => {
    void biometricPinStore.isEnabled().then(setBiometricOn);
  }, []);

  if (!api) {
    return (
      <Screen>
        <Title>Parent area</Title>
        {parentAuth.configured ? (
          <SignInPrompt />
        ) : (
          <Notice>
            <Body>
              Parent sign-in isn’t connected in this build yet, so the parent area can’t be unlocked
              here. You can manage your family in the parent portal.
            </Body>
          </Notice>
        )}
      </Screen>
    );
  }

  const finish = async (outcome: UnlockOutcome, enteredPin: string | null) => {
    if (outcome.kind === 'unlocked') {
      if (enteredPin && rememberBiometric) {
        try {
          await biometricPinStore.save(enteredPin);
          setBiometricOn(true);
        } catch {
          setInfo('Biometric unlock couldn’t be turned on. You can keep using your PIN.');
        }
      }
      const mode = await enterParentMode(secureStorage, modeEffects, {
        unlocked: true,
        unlockedUntil: outcome.unlockedUntil,
      });
      if (mode === 'parent') router.replace('/(parent)/home');
      return;
    }
    if (outcome.kind === 'pin_changed') {
      setBiometricOn(false);
      setError(outcome.message);
    } else if (outcome.kind === 'error') {
      setError(outcome.message);
    }
  };

  const unlock = async () => {
    const entered = pin;
    setPin('');
    setBusy(true);
    setError(null);
    setInfo(null);
    await finish(await unlockWithPin(api, entered), entered);
    setBusy(false);
  };

  const unlockBiometric = async () => {
    setBusy(true);
    setError(null);
    setInfo(null);
    await finish(await unlockWithBiometrics(api, biometricPinStore), null);
    setBusy(false);
  };

  return (
    <Screen>
      <Title>Parent area</Title>
      <Body>
        Enter your 6-digit parent PIN. The unlock lasts a few minutes and ends when you lock or
        leave the app.
      </Body>
      <Card>
        <Text style={styles.label} nativeID="pinLabel">
          Parent PIN
        </Text>
        <TextInput
          accessibilityLabel="Parent PIN"
          accessibilityLabelledBy="pinLabel"
          style={styles.input}
          value={pin}
          onChangeText={(v) => setPin(v.replace(/\D/g, '').slice(0, 6))}
          keyboardType="number-pad"
          secureTextEntry
          maxLength={6}
          autoComplete="off"
          textContentType="none"
          importantForAutofill="no"
          onSubmitEditing={() => void unlock()}
        />
        {canBiometric && !biometricOn ? (
          <View style={styles.row}>
            <Switch
              accessibilityLabel="Use Face ID or fingerprint next time"
              value={rememberBiometric}
              onValueChange={setRememberBiometric}
              trackColor={{ true: colors.teal, false: colors.muted }}
            />
            <Body>Use Face ID or fingerprint next time</Body>
          </View>
        ) : null}
        {canBiometric && !biometricOn && rememberBiometric ? (
          <Body muted>
            Only turn this on if your child’s face or fingerprint is not enrolled on this device.
          </Body>
        ) : null}
        <Button label={busy ? 'Checking…' : 'Unlock'} busy={busy} onPress={() => void unlock()} />
        {canBiometric && biometricOn ? (
          <>
            <Button
              label="Unlock with Face ID or fingerprint"
              secondary
              busy={busy}
              onPress={() => void unlockBiometric()}
            />
            <Button
              label="Turn off biometric unlock"
              secondary
              disabled={busy}
              onPress={() =>
                void biometricPinStore.clear().then(() => {
                  setBiometricOn(false);
                  setInfo('Biometric unlock is off.');
                })
              }
            />
          </>
        ) : null}
      </Card>
      {error ? <ErrorBox message={error} /> : null}
      {info ? <Body>{info}</Body> : null}
      <Heading>Done for now?</Heading>
      <Button
        label="Lock parent area"
        secondary
        disabled={busy}
        onPress={() =>
          void lockParentArea(api).then((ok) =>
            setInfo(
              ok ? 'Locked.' : 'We couldn’t reach PencilLift to lock. Try again when online.',
            ),
          )
        }
      />
      <SignOutButton />
      <PinResetHelp />
    </Screen>
  );
}

/** A forgotten PIN is reset in the portal after re-authentication; link there when we can. */
function PinResetHelp() {
  const guidance = pinResetGuidance(portalUrl);
  const url = guidance.url;
  return (
    <>
      <Body muted>{guidance.text}</Body>
      {url ? (
        // The unlock screen sits after sign-in but before the PIN, so leaving the app for the
        // portal is a grown-up's step behind the parental gate (Apple 1.3 / Play Families).
        <GatedButton
          label="Reset PIN in the parent portal"
          purpose="open the parent portal"
          secondary
          onPassed={() => void openExternalUrl(url)}
        />
      ) : null}
    </>
  );
}
