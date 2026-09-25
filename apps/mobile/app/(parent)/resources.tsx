import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import {
  AppState,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import type {
  MonetizationPreferences,
  PlacementResponse,
  ResourcesResponse,
} from '@pencillift/contracts';
import type { ApiClient } from '@pencillift/contracts/client';
import { colors, minTouchTarget, radii, spacing, typography } from '@pencillift/ui-tokens';
import { BrandRow } from '../../src/brand/BrandMark.tsx';
import { devicePlatform } from '../../src/family/runtime.ts';
import { registerAdultCacheClearer } from '../../src/family/parent-session.ts';
import {
  Body,
  Button,
  Card,
  Choice,
  ErrorBox,
  Heading,
  LegalLinks,
  Loading,
  Notice,
  ParentAccessState,
  styles as ui,
  Title,
  useParentAccess,
} from '../../src/family/ui.tsx';
import { currentMode, type AppMode } from '../../src/lib/mode.ts';
import { secureStorage } from '../../src/lib/secure-storage.ts';
import {
  dismissSponsorCard,
  loadPreferences,
  loadResources,
  loadSponsorCard,
  openResourceLink,
  openSponsorLink,
  reportSponsorCard,
  savePreferences,
  sendViewed,
  type OpenUrl,
} from '../../src/monetization/actions.ts';
import {
  apiLocale,
  buildResourcesView,
  buildSponsorCardView,
  CHILD_MODE_REFUSAL,
  GRADE_OPTIONS,
  monetizationError,
  NO_FILTERS,
  REPORT_OPTIONS,
  skillLabel,
  skillOptions,
  SUBJECT_OPTIONS,
  type MerchantMode,
  type MonetizationProblem,
  type ReportCategory,
  type ResourceCardView,
  type ResourceFilters,
  type SponsorCardView,
} from '../../src/monetization/view-model.ts';
import {
  createViewabilityTracker,
  createViewportSignal,
  visibleRatio,
  type Span,
  type ViewportSignal,
} from '../../src/monetization/viewability.ts';

/**
 * Parent Resources (spec P10 resources, P16.1/P16.3; AC_MON_02/03/05/08/11/12/16). A parent-chosen
 * contextual browser: subject, grade and focus skill, never a child's scores or homework. Each
 * merchant link shows its disclosure right beside it (and as its accessibility hint), never a
 * price, and opens in the system browser or merchant app via Linking.openURL after a deliberate
 * tap: never a WebView or in-app browser. At most one sponsor card appears, below and apart from
 * the educational list, with dismiss and report controls that never navigate.
 *
 * Parent area only: in child mode (or without a parent unlock) this screen makes no commercial
 * request and renders no commercial content.
 */
export default function ParentResourcesScreen() {
  const access = useParentAccess();
  const [mode, setMode] = useState<AppMode | null>(null);
  const viewport = useMemo(() => createViewportSignal(), []);
  const columnTop = useRef(0);

  useEffect(() => {
    let active = true;
    void currentMode(secureStorage).then((value) => {
      if (active) setMode(value);
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <SafeAreaView style={ui.screen} edges={['left', 'right', 'bottom']}>
      <ScrollView
        contentContainerStyle={ui.content}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={100}
        onLayout={(e) => viewport.set({ height: e.nativeEvent.layout.height })}
        onScroll={(e) =>
          viewport.set({
            top: e.nativeEvent.contentOffset.y,
            height: e.nativeEvent.layoutMeasurement.height,
          })
        }
      >
        <View
          style={ui.column}
          onLayout={(e) => {
            columnTop.current = e.nativeEvent.layout.y;
          }}
        >
          <BrandRow />
          <Title>Learning resources</Title>
          <Body muted>
            Free practice ideas and optional study materials for the subject and grade you choose.
            Nothing here is required to learn, and no product guarantees better grades.
          </Body>
          <ParentAccessState access={access} />
          {access.status === 'ready' && mode !== null ? (
            mode === 'parent' ? (
              <ParentResources api={access.api} viewport={viewport} columnTop={columnTop} />
            ) : (
              <Notice>
                <Body>{CHILD_MODE_REFUSAL}</Body>
                <Button
                  label="Unlock parent area"
                  onPress={() => router.replace('/(parent)/unlock')}
                />
              </Notice>
            )
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

/** System browser or the merchant's own app; never a WebView or in-app browser. */
const openInSystemBrowser: OpenUrl = (url) => Linking.openURL(url);

function deviceLocale(): string | null {
  try {
    return apiLocale(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return null;
  }
}

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: ResourcesResponse }
  | { readonly status: 'error'; readonly problem: MonetizationProblem };

type LinkNote = { readonly text: string; readonly alert: boolean };

function ParentResources({
  api,
  viewport,
  columnTop,
}: {
  api: ApiClient;
  viewport: ViewportSignal;
  columnTop: MutableRefObject<number>;
}) {
  const platform = devicePlatform();
  const locale = useMemo(deviceLocale, []);
  const [filters, setFilters] = useState<ResourceFilters>(NO_FILTERS);
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [lastData, setLastData] = useState<ResourcesResponse | null>(null);
  const [prefs, setPrefs] = useState<MonetizationPreferences | null>(null);
  const [placement, setPlacement] = useState<PlacementResponse | null>(null);
  const [sponsorClosed, setSponsorClosed] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<string, MerchantMode>>({});
  const [notes, setNotes] = useState<Record<string, LinkNote>>({});
  const [opening, setOpening] = useState<string | null>(null);
  const sponsorRequested = useRef(false);

  // Switching to child mode wipes everything commercial this screen holds (AC_ACCESS_07).
  useEffect(
    () =>
      registerAdultCacheClearer(() => {
        // The loaded list (affiliate items included) lives in `state` too: drop it with the rest.
        setState({ status: 'loading' });
        setLastData(null);
        setPlacement(null);
        setPrefs(null);
        setOverrides({});
        setNotes({});
        setSponsorClosed(null);
      }),
    [],
  );

  useEffect(() => {
    let active = true;
    setState({ status: 'loading' });
    loadResources(api, 'parent', filters, platform, locale).then(
      (data) => {
        if (!active || data === null) return;
        setState({ status: 'ready', data });
        setLastData(data);
        setOverrides({});
        setNotes({});
      },
      (error: unknown) => {
        if (active) setState({ status: 'error', problem: monetizationError(error, 'load') });
      },
    );
    return () => {
      active = false;
    };
  }, [api, filters, platform, locale, version]);

  useEffect(() => {
    let active = true;
    loadPreferences(api, 'parent').then(
      (value) => {
        if (active) setPrefs(value);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [api]);

  // One sponsor request per screen, after the parent's choices and the list are known. Never
  // refreshed, and never requested when sponsor cards are hidden.
  useEffect(() => {
    if (sponsorRequested.current || prefs === null || lastData === null) return;
    if (prefs.hideSponsorCards) return;
    sponsorRequested.current = true;
    void loadSponsorCard(api, 'parent', prefs, 'resources_browse', platform, locale).then(
      setPlacement,
    );
  }, [api, prefs, lastData, platform, locale]);

  const data = state.status === 'ready' ? state.data : lastData;
  const view = data ? buildResourcesView('parent', data, filters, overrides) : null;
  const sponsor = useMemo(
    () => buildSponsorCardView('parent', placement, prefs, 'resources_browse'),
    [placement, prefs],
  );
  const skills = skillOptions(data?.items ?? [], filters.skill);

  const openLink = async (card: ResourceCardView) => {
    if (!card.link || opening !== null) return;
    setOpening(card.id);
    const outcome = await openResourceLink(
      api,
      'parent',
      { id: card.id, shownMode: card.link.mode },
      platform,
      locale,
      openInSystemBrowser,
    );
    setOpening(null);
    let note: LinkNote;
    if (outcome.kind === 'opened') {
      note = { text: `Opened ${outcome.host} in your browser.`, alert: false };
    } else if (outcome.kind === 'changed') {
      setOverrides((current) => ({ ...current, [card.id]: outcome.mode }));
      note = {
        text: 'This link changed since the list loaded. Read the note beside it, then tap again.',
        alert: true,
      };
    } else {
      note = { text: outcome.message, alert: true };
    }
    setNotes((current) => ({ ...current, [card.id]: note }));
  };

  const closeSponsor = useCallback((message: string) => {
    setPlacement(null);
    setSponsorClosed(message);
  }, []);

  return (
    <>
      <Card>
        <Heading>Find resources</Heading>
        <Body muted>
          Choose the context yourself. We don’t use your child’s scores or homework to pick these.
        </Body>
        <Choice
          label="Subject"
          options={SUBJECT_OPTIONS}
          value={filters.subject ?? 'all'}
          onChange={(value) => setFilters({ ...filters, subject: value === 'all' ? null : value })}
        />
        <Choice
          label="Grade (K = kindergarten)"
          options={GRADE_OPTIONS}
          value={filters.grade === null ? 'any' : String(filters.grade)}
          onChange={(value) =>
            setFilters({ ...filters, grade: value === 'any' ? null : Number(value) })
          }
        />
        {skills.length > 0 ? (
          <Choice
            label="Focus skill (listed first)"
            options={[
              { value: '', label: 'No focus skill' },
              ...skills.map((skill) => ({ value: skill, label: skillLabel(skill) })),
            ]}
            value={filters.skill ?? ''}
            onChange={(value) => setFilters({ ...filters, skill: value === '' ? null : value })}
          />
        ) : null}
      </Card>

      {state.status === 'loading' && data === null ? <Loading label="Loading resources" /> : null}
      {state.status === 'error' ? (
        <ErrorBox
          message={state.problem.message}
          needsPin={state.problem.needsPin}
          onRetry={() => setVersion((v) => v + 1)}
        />
      ) : null}

      {view?.kind === 'ready' ? (
        <>
          <Heading>Resources</Heading>
          <Body muted>{view.orderNote}</Body>
          {view.hiddenNote ? (
            <Notice>
              <Body>{view.hiddenNote}</Body>
            </Notice>
          ) : null}
          {view.emptyMessage ? <Body>{view.emptyMessage}</Body> : null}
          {view.cards.map((card) => (
            <ResourceCard
              key={card.id}
              card={card}
              busy={opening === card.id}
              disabled={opening !== null}
              note={notes[card.id] ?? null}
              onOpen={() => void openLink(card)}
            />
          ))}
        </>
      ) : null}

      {prefs ? (
        <PreferencesCard
          api={api}
          prefs={prefs}
          onSaved={(next) => {
            if (next.hideAffiliate !== prefs.hideAffiliate) setVersion((v) => v + 1);
            if (next.hideSponsorCards) setPlacement(null);
            setPrefs(next);
          }}
        />
      ) : null}

      {sponsor ? (
        <SponsorBlock
          api={api}
          view={sponsor}
          viewport={viewport}
          columnTop={columnTop}
          onClosed={closeSponsor}
        />
      ) : sponsorClosed ? (
        <View accessibilityLiveRegion="polite" style={local.sponsorGap}>
          <Body muted>{sponsorClosed}</Body>
        </View>
      ) : null}
    </>
  );
}

function ResourceCard({
  card,
  busy,
  disabled,
  note,
  onOpen,
}: {
  card: ResourceCardView;
  busy: boolean;
  disabled: boolean;
  note: LinkNote | null;
  onOpen: () => void;
}) {
  return (
    <Card>
      <Text accessibilityRole="header" style={local.cardTitle}>
        {card.title}
      </Text>
      <Body muted>{card.meta}</Body>
      <Body>{card.description}</Body>
      {card.freeNote ? <Body>{card.freeNote}</Body> : null}
      {card.availabilityNote ? <Body>{card.availabilityNote}</Body> : null}
      {card.priceNote ? <Body>{card.priceNote}</Body> : null}
      {card.noLinkNote ? <Body muted>{card.noLinkNote}</Body> : null}
      {card.link ? (
        // The disclosure sits beside the button and wraps at any text size (never truncated).
        <View style={local.linkRow}>
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={card.link.a11yLabel}
            accessibilityHint={card.link.a11yHint}
            accessibilityState={{ disabled, busy }}
            disabled={disabled}
            onPress={onOpen}
            style={[ui.button, ui.secondary, disabled ? ui.disabled : null]}
          >
            <Text style={[ui.buttonText, ui.secondaryText]}>
              {busy ? 'Opening…' : card.link.label}
            </Text>
          </Pressable>
          <Text style={local.disclosure}>{card.link.disclosure}</Text>
          <Text style={local.hint}>Opens in your browser.</Text>
        </View>
      ) : null}
      {note ? (
        <View accessibilityRole={note.alert ? 'alert' : 'text'} accessibilityLiveRegion="polite">
          <Body>{note.text}</Body>
        </View>
      ) : null}
    </Card>
  );
}

function PreferencesCard({
  api,
  prefs,
  onSaved,
}: {
  api: ApiClient;
  prefs: MonetizationPreferences;
  onSaved: (next: MonetizationPreferences) => void;
}) {
  const [draft, setDraft] = useState(prefs);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean; needsPin: boolean } | null>(
    null,
  );
  useEffect(() => setDraft(prefs), [prefs]);

  const save = async () => {
    setBusy(true);
    setMessage(null);
    const outcome = await savePreferences(api, 'parent', draft);
    setBusy(false);
    if (outcome.ok) {
      onSaved(outcome.prefs);
      setMessage({ text: outcome.message, ok: true, needsPin: false });
    } else {
      setMessage({ text: outcome.message, ok: false, needsPin: outcome.needsPin });
    }
  };

  return (
    <Card>
      <Heading>Shopping links and sponsor cards</Heading>
      <View style={local.switchRow}>
        <Text style={local.switchLabel}>Hide shopping and affiliate links</Text>
        <Switch
          accessibilityLabel="Hide shopping and affiliate links"
          value={draft.hideAffiliate}
          onValueChange={(value) => setDraft({ ...draft, hideAffiliate: value })}
        />
      </View>
      <Body muted>Free learning options stay visible either way.</Body>
      <View style={local.switchRow}>
        <Text style={local.switchLabel}>Hide sponsor cards</Text>
        <Switch
          accessibilityLabel="Hide sponsor cards"
          value={draft.hideSponsorCards}
          onValueChange={(value) => setDraft({ ...draft, hideSponsorCards: value })}
        />
      </View>
      <Button label="Save choices" secondary busy={busy} onPress={() => void save()} />
      <Body muted>How sponsor cards and shopping links use data is described in our policies:</Body>
      <LegalLinks />
      {message ? (
        message.ok ? (
          <View accessibilityLiveRegion="polite">
            <Body>{message.text}</Body>
          </View>
        ) : (
          <ErrorBox message={message.text} needsPin={message.needsPin} />
        )
      ) : null}
    </Card>
  );
}

/**
 * The one sponsor card. It reports "viewed" at most once, after it has been at least half on
 * screen for a second with the app in the foreground; it is removed when the app goes to the
 * background (the parent area relocks then).
 */
function SponsorBlock({
  api,
  view,
  viewport,
  columnTop,
  onClosed,
}: {
  api: ApiClient;
  view: SponsorCardView;
  viewport: ViewportSignal;
  columnTop: MutableRefObject<number>;
  onClosed: (message: string) => void;
}) {
  const box = useRef<Span | null>(null);
  const measureRef = useRef<(() => void) | null>(null);
  // At most one "viewed" beacon per served card, however often this block re-renders.
  const viewedSent = useRef(false);
  const serveToken = view.serveToken;
  const [reporting, setReporting] = useState(false);
  const [category, setCategory] = useState<ReportCategory | 'unset'>('unset');
  const [busy, setBusy] = useState<'open' | 'report' | null>(null);
  const [problem, setProblem] = useState<MonetizationProblem | null>(null);

  useEffect(() => {
    const tracker = createViewabilityTracker({
      now: () => Date.now(),
      setTimer: (run, ms) => setTimeout(run, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      onViewable: (measure) => {
        if (viewedSent.current) return;
        viewedSent.current = true;
        void sendViewed(api, { serveToken }, measure);
      },
    });
    let appActive = AppState.currentState === 'active';
    const measure = () => {
      const card = box.current;
      const ratio = card
        ? visibleRatio({ top: columnTop.current + card.top, height: card.height }, viewport.get())
        : 0;
      tracker.update({ ratio, appActive });
    };
    measureRef.current = measure;
    const unsubscribe = viewport.subscribe(measure);
    const subscription = AppState.addEventListener('change', (next) => {
      appActive = next === 'active';
      measure();
      if (next === 'background') onClosed('');
    });
    measure();
    return () => {
      measureRef.current = null;
      unsubscribe();
      subscription.remove();
      tracker.dispose();
    };
  }, [api, serveToken, viewport, columnTop, onClosed]);

  const open = async () => {
    setBusy('open');
    setProblem(null);
    const outcome = await openSponsorLink(api, 'parent', view, openInSystemBrowser);
    setBusy(null);
    if (outcome.kind === 'gone') onClosed(outcome.message);
    else if (outcome.kind === 'error') setProblem(outcome);
  };

  const dismiss = () => {
    void dismissSponsorCard(api, view);
    onClosed('Sponsored card dismissed.');
  };

  const sendReport = async () => {
    if (category === 'unset') {
      setProblem({ message: 'Choose what is wrong with this card.', needsPin: false });
      return;
    }
    setBusy('report');
    setProblem(null);
    const outcome = await reportSponsorCard(api, view, category);
    setBusy(null);
    if (outcome.ok) onClosed(outcome.message);
    else setProblem(outcome);
  };

  return (
    <View
      style={local.sponsor}
      onLayout={(e) => {
        box.current = { top: e.nativeEvent.layout.y, height: e.nativeEvent.layout.height };
        measureRef.current?.();
      }}
    >
      <Text style={local.sponsorLabel}>{view.label}</Text>
      <Body muted>{view.whyShown}</Body>
      {view.headline ? <Text style={local.cardTitle}>{view.headline}</Text> : null}
      {view.body ? <Body>{view.body}</Body> : null}
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={view.ctaLabel}
        accessibilityHint={view.ctaA11yHint}
        accessibilityState={{ disabled: busy !== null, busy: busy === 'open' }}
        disabled={busy !== null}
        onPress={() => void open()}
        style={[ui.button, busy !== null ? ui.disabled : null]}
      >
        <Text style={ui.buttonText}>{busy === 'open' ? 'Opening…' : view.ctaLabel}</Text>
      </Pressable>
      <Body muted>{view.leaveNote}</Body>
      <View style={ui.row}>
        <Button label="Dismiss" secondary onPress={dismiss} />
        {reporting ? null : (
          <Button
            label="Report this ad"
            secondary
            disabled={busy !== null}
            onPress={() => {
              setReporting(true);
              setProblem(null);
            }}
          />
        )}
      </View>
      {reporting ? (
        <>
          <Choice<ReportCategory | 'unset'>
            label="What is wrong with this card?"
            options={REPORT_OPTIONS}
            value={category}
            onChange={setCategory}
          />
          <View style={ui.row}>
            <Button
              label="Send report"
              busy={busy === 'report'}
              onPress={() => void sendReport()}
            />
            <Button
              label="Cancel"
              secondary
              disabled={busy !== null}
              onPress={() => {
                setReporting(false);
                setCategory('unset');
                setProblem(null);
              }}
            />
          </View>
        </>
      ) : null}
      {problem ? <ErrorBox message={problem.message} needsPin={problem.needsPin} /> : null}
    </View>
  );
}

const local = StyleSheet.create({
  cardTitle: { fontSize: typography.scale.md, fontWeight: '800', color: colors.navy },
  linkRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  disclosure: {
    flexShrink: 1,
    fontSize: typography.scale.md,
    fontWeight: '800',
    color: colors.navy,
  },
  hint: { flexShrink: 1, fontSize: typography.scale.md, color: colors.muted },
  switchRow: {
    minHeight: minTouchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  switchLabel: { flex: 1, fontSize: typography.scale.md, color: colors.navy },
  // Visibly separate from the educational list: extra space and a dashed outline.
  sponsor: {
    marginTop: spacing.xl,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.muted,
    backgroundColor: colors.white,
  },
  sponsorGap: { marginTop: spacing.xl },
  sponsorLabel: { fontSize: typography.scale.md, fontWeight: '800', color: colors.navy },
});
