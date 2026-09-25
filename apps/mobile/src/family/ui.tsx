import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  AppState,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import type { ApiClient } from '@pencillift/contracts/client';
import { colors, minTouchTarget, radii, spacing, typography } from '@pencillift/ui-tokens';
import { BrandRow } from '../brand/BrandMark.tsx';
import { currentMode } from '../lib/mode.ts';
import { secureStorage } from '../lib/secure-storage.ts';
import { parentApi } from './runtime.ts';
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
  children,
  edges = DEFAULT_EDGES,
}: {
  children: ReactNode;
  edges?: readonly Edge[] | undefined;
}) {
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
  | { readonly status: 'no_session' }
  | { readonly status: 'ready'; readonly api: ApiClient };

/**
 * Gate for parent screens (AC_ACCESS_07): a device in child mode never shows parent data, even via
 * a deep link. Returning to the parent area requires a fresh server-verified PIN on the unlock
 * screen. Without a parent sign-in on this device, screens show an honest "not connected" state.
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
      setAccess(api ? { status: 'ready', api } : { status: 'no_session' });
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
  if (access.status === 'no_session') {
    return (
      <Notice>
        <Body>
          Parent sign-in isn’t connected on this device yet, so family details can’t be shown here.
          You can manage your family in the parent portal.
        </Body>
      </Notice>
    );
  }
  return null;
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
    backgroundColor: colors.teal,
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
  chipSelected: { backgroundColor: colors.teal },
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
