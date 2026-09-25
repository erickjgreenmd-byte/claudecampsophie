import { useEffect, useState } from 'react';
import { Text, TextInput } from 'react-native';
import { router } from 'expo-router';
import { colors } from '@pencillift/ui-tokens';
import { enterChildMode } from '../src/lib/mode.ts';
import { secureStorage } from '../src/lib/secure-storage.ts';
import {
  defaultDeviceLabel,
  formatPairingInput,
  validatePairingCode,
} from '../src/family/pairing-code.ts';
import { deviceNameChoices } from '../src/family/parental-gate.ts';
import { childSession, devicePlatform, modeEffects } from '../src/family/runtime.ts';
import { Body, Button, Card, Choice, ErrorBox, Screen, styles, Title } from '../src/family/ui.tsx';

/** This root route has no native header, so the screen applies the top inset itself. */
const ROOT_EDGES = ['top', 'left', 'right', 'bottom'] as const;

/**
 * Connect a child's device (spec P3; AC_ACCESS_04/07). A grown-up gives the child a one-time code
 * from the parent area. Redeeming it creates a child-only session; it can never open the parent
 * area. After pairing, the device switches to child mode, which clears any parent data from it.
 * The device name is a fixed choice, never free text, so a child cannot type personal information
 * here (PLAY-05); a parent can rename the device in the parent area.
 */
export default function PairScreen() {
  const platform = devicePlatform();
  const nameChoices = deviceNameChoices(platform);
  const [code, setCode] = useState('');
  const [label, setLabel] = useState(defaultDeviceLabel(platform));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairedName, setPairedName] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void childSession.isPaired().then(async (paired) => {
      if (!paired || !active) return;
      const profile = await childSession.profile();
      if (active) setPairedName(profile?.nickname ?? 'your child');
    });
    return () => {
      active = false;
    };
  }, []);

  const connect = async () => {
    const check = validatePairingCode(code);
    if (!check.ok) {
      setError(check.message);
      return;
    }
    setBusy(true);
    setError(null);
    const result = await childSession.pair({ code: check.code, deviceLabel: label, platform });
    if (!result.ok) {
      setBusy(false);
      setError(result.message);
      return;
    }
    // Clears adult caches, relocks the parent area on the server and resets navigation.
    await enterChildMode(secureStorage, modeEffects);
  };

  if (pairedName) {
    return (
      <Screen edges={ROOT_EDGES}>
        <Title>This device is connected</Title>
        <Body>This device is connected to {pairedName}’s space.</Body>
        <Button
          label="Go to my space"
          onPress={() => void enterChildMode(secureStorage, modeEffects)}
        />
      </Screen>
    );
  }

  return (
    <Screen edges={ROOT_EDGES}>
      <Title>Connect a child’s device</Title>
      <Body>Ask a grown-up for your connect code. It has 8 letters and numbers.</Body>
      <Card>
        <Text style={styles.label} nativeID="codeLabel">
          Connect code
        </Text>
        <TextInput
          accessibilityLabel="Connect code"
          accessibilityLabelledBy="codeLabel"
          style={[styles.input, { letterSpacing: 3, textAlign: 'center' }]}
          value={code}
          onChangeText={(v) => {
            setCode(formatPairingInput(v));
            setError(null);
          }}
          autoCapitalize="characters"
          autoCorrect={false}
          autoComplete="off"
          maxLength={9}
          placeholder="ABCD-1234"
          placeholderTextColor={colors.muted}
          onSubmitEditing={() => void connect()}
        />
        <Choice
          label="What is this device? (a grown-up can rename it later)"
          options={nameChoices}
          value={label}
          onChange={setLabel}
        />
        <Button
          label={busy ? 'Connecting…' : 'Connect'}
          busy={busy}
          onPress={() => void connect()}
        />
      </Card>
      {error ? <ErrorBox message={error} /> : null}
      <Button
        label="Back"
        secondary
        disabled={busy}
        onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      />
    </Screen>
  );
}
