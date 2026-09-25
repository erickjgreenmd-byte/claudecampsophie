import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  AppState,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import type { ApiClient } from '@pencillift/contracts/client';
import { colors, minTouchTarget, radii, spacing, typography } from '@pencillift/ui-tokens';
import { BrandRow } from '../brand/BrandMark.tsx';
import { legalLinks } from '../lib/legal-links.ts';
import { currentMode, parentUnlockActive } from '../lib/mode.ts';
import { parentAuth, portalUrl } from '../lib/parent-auth.ts';
import { secureStorage } from '../lib/secure-storage.ts';
import { answerGate, gateLock, openGate, type GateState } from './parental-gate.ts';
import { parentApi, signOutParentOnDevice } from './runtime.ts';
import { lockParentArea } from './unlock.ts';

/**
 * Shared building blocks for the family screens: safe areas, keyboard avoidance, scrolling for
 * large text, 44pt touch targets, and text labels on every state (never colour alone).
 */

/** Screens under a native header or an inset layout leave the top edge to it. */
const DEFAULT_EDGES: readonly Edge[] = ['left', 'right', 'bottom'];

/**
 * Screen chrome: the brand row (mark only; the screen's Title stays the H1) above the content, in
 * a centred column that stays readable on tablets (max 640 px, 16 px gutters). A root route shown
 * without a header (/pair) passes `edges` including 'top'.
 */
export function Screen({
  children: content,
  edges = DEFAULT_EDGES,
  childNav,
}: {
  children: ReactNode;
  edges?: readonly Edge[] | undefined;
  /** Child screens have no native header: show the Home (and Back) controls under the brand row. */
  childNav?: 'home' | 'home_and_back' | undefined;
}) {
  // The brand row always comes first; a child screen's nav is the first thing under it.
  const children = childNav ? (
    <>
      <ChildNav back={childNav === 'home_and_back'} />
      {content}
    </>
  ) : (
    content
  );
  return (
    <SafeAreaView style={styles.screen} edges={edges}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.column}>
            <BrandRow />
            {children}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/** Returns to the child home with no child screens left underneath it. */
export function goToChildHome(): void {
  if (router.canDismiss()) router.dismissAll();
  router.replace('/(child)/home');
}

/** One screen back; from the bottom of the stack, the child home. */
export function goBackOrChildHome(): void {
  if (router.canGoBack()) router.back();
  else goToChildHome();
}

/**
 * Persistent way out of every child screen (MOB-R1-07): the child space hides the native header,
 * so a child on a tablet without a reliable edge-swipe still has an on-screen Home (and Back).
 */
export function ChildNav({ back = true }: { back?: boolean | undefined }) {
  return (
    <View style={styles.childNav} accessibilityRole="toolbar" accessibilityLabel="Navigation">
      {back ? (
        <Button
          label="Back"
          secondary
          accessibilityLabel="Back to the previous screen"
          onPress={goBackOrChildHome}
        />
      ) : null}
      <Button label="Home" secondary accessibilityLabel="Go to my home" onPress={goToChildHome} />
    </View>
  );
}

export function Title({ children }: { children: ReactNode }) {
  return (
    <Text accessibilityRole="header" style={styles.title}>
      {children}
    </Text>
  );
}

export function Heading({ children }: { children: ReactNode }) {
  return (
    <Text accessibilityRole="header" style={styles.heading}>
      {children}
    </Text>
  );
}

export function Body({ children, muted }: { children: ReactNode; muted?: boolean | undefined }) {
  return <Text style={[styles.body, muted ? styles.muted : null]}>{children}</Text>;
}

export function Card({ children }: { children: ReactNode }) {
  return <View style={styles.card}>{children}</View>;
}

export function Notice({ children, alert }: { children: ReactNode; alert?: boolean | undefined }) {
  return (
    <View
      style={[styles.card, alert ? styles.alert : styles.notice]}
      accessibilityRole={alert ? 'alert' : 'summary'}
      accessibilityLiveRegion={alert ? 'assertive' : 'polite'}
    >
      {children}
    </View>
  );
}

export function Button({
  label,
  onPress,
  secondary,
  disabled,
  busy,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  secondary?: boolean | undefined;
  disabled?: boolean | undefined;
  busy?: boolean | undefined;
  accessibilityLabel?: string | undefined;
}) {
  const off = disabled === true || busy === true;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: off, busy: busy === true }}
      disabled={off}
      onPress={onPress}
      style={[styles.button, secondary ? styles.secondary : null, off ? styles.disabled : null]}
    >
      <Text style={[styles.buttonText, secondary ? styles.secondaryText : null]}>{label}</Text>
    </Pressable>
  );
}

/** Single-choice chips. Selection is shown with a check mark and announced, not colour alone. */
export function Choice<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.row}>
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityLabel={option.label}
              accessibilityState={{ checked: selected }}
              onPress={() => onChange(option.value)}
              style={[styles.chip, selected ? styles.chipSelected : null]}
            >
              <Text style={[styles.chipText, selected ? styles.chipTextSelected : null]}>
                {selected ? `✓ ${option.label}` : option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <ActivityIndicator color={colors.teal} accessibilityLabel={label} style={styles.loading} />
  );
}

/** Error with an optional retry and, when the server wants a PIN, a route to unlock. */
export function ErrorBox({
  message,
  onRetry,
  needsPin,
}: {
  message: string;
  onRetry?: (() => void) | undefined;
  needsPin?: boolean | undefined;
}) {
  return (
    <Notice alert>
      <Body>{message}</Body>
      {needsPin ? (
        <Button label="Unlock with parent PIN" onPress={() => router.push('/(parent)/unlock')} />
      ) : null}
      {onRetry ? <Button label="Try again" secondary onPress={onRetry} /> : null}
    </Notice>
  );
}

export type ParentAccess =
  | { readonly status: 'checking' }
  | { readonly status: 'child_mode' }
  /** Parent sign-in is configured in this build, but nobody is signed in on this device. */
  | { readonly status: 'no_session' }
  /** This build has no parent sign-in at all (no Supabase project configured). */
  | { readonly status: 'not_configured' }
  /** Signed in, but the PIN unlock has not happened since the app started (or has lapsed). */
  | { readonly status: 'locked' }
  | { readonly status: 'ready'; readonly api: ApiClient };

/**
 * Gate for parent screens (AC_ACCESS_07): a device in child mode never shows parent data, even via
 * a deep link. Returning to the parent area requires a fresh server-verified PIN on the unlock
 * screen, and so does a cold start or a lapsed unlock (MOB-R1-09): the client-side unlock is held
 * in memory only, so a deep link into a parent screen after a restart goes to the unlock screen.
 * Without a parent sign-in on this device, screens offer the sign-in (MOB-R1-08).
 */
export function useParentAccess(): ParentAccess {
  const [access, setAccess] = useState<ParentAccess>({ status: 'checking' });
  useEffect(() => {
    let active = true;
    void currentMode(secureStorage).then((mode) => {
      if (!active) return;
      if (mode === 'child') {
        setAccess({ status: 'child_mode' });
        return;
      }
      const api = parentApi();
      if (!api) {
        setAccess({ status: parentAuth.configured ? 'no_session' : 'not_configured' });
        return;
      }
      if (!parentUnlockActive(new Date())) {
        setAccess({ status: 'locked' });
        router.replace('/(parent)/unlock');
        return;
      }
      setAccess({ status: 'ready', api });
    });
    return () => {
      active = false;
    };
  }, []);
  useRelockOnBackground(access.status === 'ready' ? access.api : null);
  return access;
}

/**
 * Spec P3: relock on backgrounding. When the app leaves the foreground while a parent screen is
 * open, the server-side unlock is revoked so returning needs the PIN again.
 */
export function useRelockOnBackground(api: ApiClient | null): void {
  useEffect(() => {
    if (!api) return;
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'background') void lockParentArea(api);
    });
    return () => subscription.remove();
  }, [api]);
}

/** Renders the non-ready parent access states; returns null when the screen may render. */
export function ParentAccessState({ access }: { access: ParentAccess }) {
  if (access.status === 'checking') return <Loading label="Checking parent access" />;
  if (access.status === 'child_mode') {
    return (
      <Notice>
        <Body>This device is in child mode. A grown-up needs to unlock the parent area first.</Body>
        <Button label="Unlock parent area" onPress={() => router.replace('/(parent)/unlock')} />
      </Notice>
    );
  }
  if (access.status === 'locked') {
    return (
      <Notice>
        <Body>Enter your parent PIN to open the parent area.</Body>
        <Button label="Unlock parent area" onPress={() => router.replace('/(parent)/unlock')} />
      </Notice>
    );
  }
  if (access.status === 'no_session') return <SignInPrompt />;
  if (access.status === 'not_configured') {
    return (
      <Notice>
        <Body>
          Parent sign-in isn’t connected in this build yet, so family details can’t be shown here.
          You can manage your family in the parent portal.
        </Body>
      </Notice>
    );
  }
  return null;
}

/**
 * A signed-out parent on a configured build is offered the sign-in (MOB-R1-08); the sign-in screen
 * replaces this one and continues to the PIN unlock, so no dead end and no doubled screens.
 */
export function SignInPrompt() {
  return (
    <Notice>
      <Body>Sign in as a parent to see and manage your family on this device.</Body>
      <Button label="Sign in as a parent" onPress={() => router.replace('/(parent)/sign-in')} />
    </Notice>
  );
}

/**
 * Ends the parent session on this device (MOB-R1-01): server relock, Supabase sign-out, adult
 * caches and store identity cleared, then the welcome screen. A paired child stays paired.
 */
export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      label={busy ? 'Signing out…' : 'Sign out'}
      secondary
      busy={busy}
      accessibilityLabel="Sign out of the parent account on this device"
      onPress={() => {
        setBusy(true);
        void signOutParentOnDevice().finally(() => setBusy(false));
      }}
    />
  );
}

/** Load helper with explicit loading/error/ready states and a reload. */
export function useLoad<T>(load: (() => Promise<T>) | null) {
  const [state, setState] = useState<
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'error'; error: unknown }
    | { status: 'ready'; data: T }
  >({ status: 'idle' });
  const run = useCallback(async () => {
    if (!load) return;
    setState((s) => (s.status === 'ready' ? s : { status: 'loading' }));
    try {
      setState({ status: 'ready', data: await load() });
    } catch (error) {
      setState({ status: 'error', error });
    }
  }, [load]);
  useEffect(() => {
    void run();
  }, [run]);
  return { state, reload: run };
}

/** Opens a link in the system browser; a failure to open is not an error the parent can act on. */
export function openExternalUrl(url: string): Promise<void> {
  return Linking.openURL(url).catch(() => undefined);
}

/**
 * The gate's lock outlives one open gate (module state, never persisted): cancelling and reopening
 * the gate does not reset the lockout after three misses.
 */
let lastGate: GateState | null = null;

/**
 * Parental gate (Apple guideline 1.3 / Play Families; APL-02 / PLAY-07): a random multiplication a
 * grown-up answers before anything leaves the app from a screen a child can reach. Three misses lock
 * it for a short while. The right answer is never shown or spoken.
 */
export function ParentalGate({
  purpose,
  onPassed,
  onCancel,
}: {
  /** What passing the gate does, e.g. "open the privacy policy". */
  purpose: string;
  onPassed: () => void;
  onCancel: () => void;
}) {
  const [state, setState] = useState<GateState>(() => openGate(Date.now(), Math.random, lastGate));
  const [answer, setAnswer] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const lock = gateLock(state, now);

  useEffect(() => {
    lastGate = state;
  }, [state]);

  // While locked, count the seconds down and draw a fresh challenge once the lock ends.
  useEffect(() => {
    if (!lock.locked) return;
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (!gateLock(state, t).locked) {
        setState(openGate(t, Math.random, state));
        setMessage(null);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [lock.locked, state]);

  const check = () => {
    const outcome = answerGate(state, answer, Date.now());
    setAnswer('');
    setNow(Date.now());
    if (outcome.kind === 'passed') {
      setState(outcome.state);
      setMessage(null);
      onPassed();
      return;
    }
    setState(outcome.state);
    setMessage(outcome.message);
  };

  return (
    <View
      style={[styles.card, styles.notice]}
      accessibilityLabel={`Grown-ups only: ${purpose}`}
      accessibilityLiveRegion="polite"
    >
      <Text style={styles.label}>Grown-ups only</Text>
      <Body>
        To {purpose}, a grown-up answers this first. {state.challenge.prompt}
      </Body>
      {lock.locked ? (
        <Body>
          Too many tries. Please wait {lock.retryInSeconds}{' '}
          {lock.retryInSeconds === 1 ? 'second' : 'seconds'}, then ask a grown-up to try again.
        </Body>
      ) : (
        <>
          <Text nativeID="gateAnswerLabel" style={styles.label}>
            Answer
          </Text>
          <TextInput
            accessibilityLabel="Answer"
            accessibilityLabelledBy="gateAnswerLabel"
            style={styles.input}
            value={answer}
            onChangeText={setAnswer}
            keyboardType="number-pad"
            maxLength={4}
            autoComplete="off"
            autoCorrect={false}
            onSubmitEditing={check}
          />
          {message ? <Body>{message}</Body> : null}
          <Button label="Check" onPress={check} disabled={answer.trim().length === 0} />
        </>
      )}
      <Button label="Cancel" secondary onPress={onCancel} />
    </View>
  );
}

/** A button whose action runs only after the parental gate is passed. */
export function GatedButton({
  label,
  purpose,
  onPassed,
  secondary,
  disabled,
  accessibilityLabel,
}: {
  label: string;
  /** What the action does, in the gate's words; defaults to the button label. */
  purpose?: string | undefined;
  onPassed: () => void;
  secondary?: boolean | undefined;
  disabled?: boolean | undefined;
  accessibilityLabel?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        label={label}
        secondary={secondary}
        disabled={disabled}
        accessibilityLabel={accessibilityLabel ?? `${label} (grown-ups only)`}
        onPress={() => setOpen(true)}
      />
      {open ? (
        <ParentalGate
          purpose={purpose ?? label.toLowerCase()}
          onPassed={() => {
            setOpen(false);
            onPassed();
          }}
          onCancel={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/** Gated-link helper: an outbound link that opens in the system browser only past the gate. */
export function GatedLinkButton({
  label,
  url,
  purpose,
  secondary,
}: {
  label: string;
  url: string;
  purpose?: string | undefined;
  secondary?: boolean | undefined;
}) {
  return (
    <GatedButton
      label={label}
      purpose={purpose ?? `open ${label.toLowerCase()}`}
      secondary={secondary}
      onPassed={() => void openExternalUrl(url)}
    />
  );
}

/**
 * Privacy policy and Terms of use links (APL-06 / PLAY-20), on the public parent portal. `gated`
 * puts them behind the parental gate for screens reachable without the parent PIN; screens already
 * behind the PIN open them directly. Without a configured portal the links are named, not invented.
 */
export function LegalLinks({ gated }: { gated?: boolean | undefined }) {
  const links = legalLinks(portalUrl);
  if (links.length === 0) {
    return (
      <Body muted>
        The Privacy policy and Terms of use are on the PencilLift parent portal (not configured in
        this build).
      </Body>
    );
  }
  return (
    <View style={styles.row}>
      {links.map((link) =>
        gated ? (
          <GatedLinkButton key={link.key} label={link.label} url={link.url} secondary />
        ) : (
          <Button
            key={link.key}
            label={link.label}
            secondary
            onPress={() => void openExternalUrl(link.url)}
          />
        ),
      )}
    </View>
  );
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.offWhite },
  content: { padding: spacing.md, paddingBottom: spacing.xxl, alignItems: 'center' },
  // Tablet layouts (iPad, Fire HD): a readable column that does not stretch edge to edge.
  column: { width: '100%', maxWidth: 640 },
  title: {
    fontSize: typography.scale.xl,
    fontWeight: '800',
    color: colors.navy,
    marginBottom: spacing.sm,
  },
  heading: {
    fontSize: typography.scale.lg,
    fontWeight: '800',
    color: colors.navy,
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  body: { fontSize: typography.scale.md, color: colors.navy, marginVertical: spacing.xs },
  muted: { color: colors.muted },
  card: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    marginVertical: spacing.sm,
  },
  notice: { borderLeftWidth: 4, borderLeftColor: colors.gold },
  alert: { borderLeftWidth: 4, borderLeftColor: colors.danger },
  button: {
    minHeight: minTouchTarget,
    borderRadius: radii.pill,
    backgroundColor: colors.tealText,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    marginVertical: spacing.xs,
  },
  secondary: { backgroundColor: colors.white, borderWidth: 2, borderColor: colors.teal },
  disabled: { opacity: 0.55 },
  buttonText: { color: colors.white, fontSize: typography.scale.md, fontWeight: '800' },
  secondaryText: { color: colors.tealText },
  loading: { marginVertical: spacing.lg },
  input: {
    minHeight: minTouchTarget,
    borderWidth: 1,
    borderColor: colors.muted,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    fontSize: typography.scale.lg,
    color: colors.navy,
    backgroundColor: colors.white,
    marginVertical: spacing.xs,
  },
  label: {
    fontSize: typography.scale.md,
    fontWeight: '800',
    color: colors.navy,
    marginTop: spacing.sm,
  },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  childNav: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.sm },
  chip: {
    minHeight: minTouchTarget,
    minWidth: minTouchTarget,
    borderRadius: radii.pill,
    borderWidth: 2,
    borderColor: colors.teal,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  chipSelected: { backgroundColor: colors.tealText },
  chipText: { color: colors.tealText, fontWeight: '800', fontSize: typography.scale.md },
  chipTextSelected: { color: colors.white },
  code: {
    fontSize: typography.scale.xxl,
    fontWeight: '800',
    letterSpacing: 4,
    color: colors.navy,
    textAlign: 'center',
    marginVertical: spacing.md,
  },
});
