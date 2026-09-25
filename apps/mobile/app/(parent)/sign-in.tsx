import { useState } from 'react';
import { Text, TextInput } from 'react-native';
import { router } from 'expo-router';
import { colors } from '@pencillift/ui-tokens';
import { parentAuth, portalUrl } from '../../src/lib/parent-auth.ts';
import {
  Body,
  Button,
  ErrorBox,
  GatedLinkButton,
  LegalLinks,
  Notice,
  Screen,
  styles,
  Title,
} from '../../src/family/ui.tsx';

/**
 * Parent sign-in (spec P3). After signing in, the parent area still needs a fresh PIN unlock.
 * Account creation and password changes happen on the web portal, opened in the system browser.
 * This screen is reachable without the parent PIN, so every outbound link (sign-up, privacy policy,
 * terms of use) sits behind the parental gate (APL-02 / PLAY-07; APL-06 / PLAY-20).
 */
export default function ParentSignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetSent, setResetSent] = useState(false);

  if (!parentAuth.configured) {
    return (
      <Screen>
        <Title>Parent sign in</Title>
        <Notice>
          <Body>
            Parent sign-in isn’t connected in this build yet, so no family data can be shown on this
            device.
          </Body>
        </Notice>
        <LegalLinks gated />
      </Screen>
    );
  }

  async function submit() {
    if (busy) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || password.length === 0) {
      setError('Enter your email and password.');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await parentAuth.signIn(email, password).catch(() => ({
      ok: false as const,
      message: 'Something went wrong. Check your connection and try again.',
    }));
    setBusy(false);
    setPassword('');
    if (result.ok) router.replace('/(parent)/unlock');
    else setError(result.message);
  }

  return (
    <Screen>
      <Title>Parent sign in</Title>
      <Text nativeID="emailLabel" style={{ color: colors.navy }}>
        Email
      </Text>
      <TextInput
        accessibilityLabel="Email"
        accessibilityLabelledBy="emailLabel"
        style={styles.input}
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        textContentType="username"
      />
      <Text nativeID="passwordLabel" style={{ color: colors.navy }}>
        Password
      </Text>
      <TextInput
        accessibilityLabel="Password"
        accessibilityLabelledBy="passwordLabel"
        style={styles.input}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="password"
        textContentType="password"
      />
      {error ? <ErrorBox message={error} /> : null}
      <Button label="Sign in" onPress={() => void submit()} busy={busy} />
      {resetSent ? (
        <Notice>
          <Body>If that email has a PencilLift account, a reset link is on its way.</Body>
        </Notice>
      ) : (
        <Button
          label="Forgot password"
          secondary
          onPress={() => {
            if (!email.trim()) {
              setError('Enter your email first, then tap Forgot password.');
              return;
            }
            void parentAuth.sendPasswordReset(email).finally(() => setResetSent(true));
          }}
        />
      )}
      {portalUrl ? (
        <GatedLinkButton
          label="Create a parent account"
          purpose="open the parent portal to create an account"
          url={`${portalUrl}/sign-up`}
          secondary
        />
      ) : null}
      <LegalLinks gated />
    </Screen>
  );
}
