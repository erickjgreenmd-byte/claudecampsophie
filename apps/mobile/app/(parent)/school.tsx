import { useCallback, useMemo, useState } from 'react';
import { Switch, Text, TextInput, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import type { ApiClient } from '@pencillift/contracts/client';
import { formatUsd, priceTable } from '@pencillift/domain';
import { colors } from '@pencillift/ui-tokens';
import { devicePlatform } from '../../src/family/runtime.ts';
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
import {
  chooseSchool,
  loadFamilySchool,
  loadProblem,
  loadPromoHistory,
  quotePromo,
  redeemPromo,
  searchSchools,
  type PromoProblem,
  type PromoRequest,
} from '../../src/promotions/actions.ts';
import type {
  FamilySchool,
  PromoQuote,
  PromoRedemption,
  SchoolSummary,
} from '../../src/promotions/types.ts';
import {
  buildQuoteView,
  buildSchoolView,
  channelForPlatform,
  chooseSchoolPrompt,
  CONTRIBUTION_LINES,
  historyRows,
  NATIVE_STORE_STEP_AVAILABLE,
  nextActionLine,
  ONE_SCHOOL_RULE,
  schoolPlace,
  STATE_LABEL,
  STORE_NAME,
} from '../../src/promotions/view-model.ts';

/**
 * Parent School and promotions (spec P17 parent interfaces; AC_PROMO_14, AC_UX_01/02). One school
 * per family with next-month changes, the PencilLift-funded contribution rule, and monthly promo
 * code previews. Parent area only: child mode never reaches this screen (useParentAccess).
 */
export default function SchoolScreen() {
  const access = useParentAccess();
  return (
    <Screen>
      <Title>School and promotions</Title>
      <ParentAccessState access={access} />
      {access.status === 'ready' ? <SchoolAndPromotions api={access.api} /> : null}
    </Screen>
  );
}

const display = { nativeStoreStepAvailable: NATIVE_STORE_STEP_AVAILABLE };

function SchoolAndPromotions({ api }: { api: ApiClient }) {
  const [historyVersion, setHistoryVersion] = useState(0);
  return (
    <>
      <SchoolCard api={api} />
      <Card>
        <Heading>How the school contribution works</Heading>
        {CONTRIBUTION_LINES.map((line) => (
          <Body key={line}>• {line}</Body>
        ))}
      </Card>
      <PromoCard api={api} onRedeemed={() => setHistoryVersion((v) => v + 1)} />
      <HistoryCard api={api} version={historyVersion} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// School
// ---------------------------------------------------------------------------------------------

function SchoolCard({ api }: { api: ApiClient }) {
  const load = useCallback(() => loadFamilySchool(api), [api]);
  const { state, reload } = useLoad(load);
  const [saved, setSaved] = useState<FamilySchool | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [problem, setProblem] = useState<PromoProblem | null>(null);
  const [busy, setBusy] = useState(false);

  const data = saved ?? (state.status === 'ready' ? state.data : null);

  const choose = async (school: SchoolSummary) => {
    setBusy(true);
    setProblem(null);
    const result = await chooseSchool(api, school);
    setBusy(false);
    if (result.ok) {
      setSaved(result.data);
      setMessage(result.message);
      return true;
    }
    setProblem(result.problem);
    return false;
  };

  if (!data) {
    if (state.status === 'error') {
      const p = loadProblem(state.error);
      return (
        <Card>
          <Heading>Your school</Heading>
          <ErrorBox message={p.message} onRetry={p.noFamily ? undefined : () => void reload()} />
        </Card>
      );
    }
    return <Loading label="Loading your school" />;
  }

  const view = buildSchoolView(data);
  return (
    <Card>
      <Heading>Your school</Heading>
      <Body>{view.currentLine}</Body>
      {view.pendingLine ? (
        <Notice>
          <Body>{view.pendingLine}</Body>
          {view.keepCurrent ? (
            <Button
              label={`Keep ${view.keepCurrent.name}`}
              accessibilityLabel={`Keep ${view.keepCurrent.name} and cancel the change`}
              secondary
              busy={busy}
              onPress={() => view.keepCurrent && void choose(view.keepCurrent)}
            />
          ) : null}
        </Notice>
      ) : null}
      {message ? (
        <Text accessibilityLiveRegion="polite" style={[styles.body, { color: colors.success }]}>
          {message}
        </Text>
      ) : null}
      <Body>{ONE_SCHOOL_RULE}</Body>
      <Body muted>{view.timezoneLine}</Body>
      <SchoolSearch api={api} data={data} busy={busy} onChoose={choose} />
      {problem ? <ErrorBox message={problem.message} needsPin={problem.needsPin} /> : null}
    </Card>
  );
}

function SchoolSearch({
  api,
  data,
  busy,
  onChoose,
}: {
  api: ApiClient;
  data: FamilySchool;
  busy: boolean;
  onChoose: (school: SchoolSummary) => Promise<boolean>;
}) {
  const [text, setText] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<{ query: string; schools: SchoolSummary[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState<SchoolSummary | null>(null);

  const search = async () => {
    setSearching(true);
    setError(null);
    setChoosing(null);
    const found = await searchSchools(api, text);
    setSearching(false);
    if (found.ok) setResults({ query: found.query, schools: found.schools });
    else setError(found.message);
  };

  return (
    <View>
      <Text style={styles.label} nativeID="school-search-label">
        Find your school
      </Text>
      <TextInput
        style={styles.input}
        value={text}
        maxLength={80}
        autoCorrect={false}
        accessibilityLabel="Find your school"
        accessibilityLabelledBy="school-search-label"
        returnKeyType="search"
        onChangeText={(value) => {
          setText(value);
          setError(null);
        }}
        onSubmitEditing={() => void search()}
      />
      <Button
        label={searching ? 'Searching…' : 'Search'}
        secondary
        busy={searching}
        onPress={() => void search()}
      />
      {error ? <ErrorBox message={error} /> : null}
      {results && results.schools.length === 0 ? (
        <Body>
          No schools match “{results.query}”. Only schools PencilLift has verified appear here.
        </Body>
      ) : null}
      {results?.schools.map((s) =>
        data.current?.id === s.id && !data.pending ? (
          <Body key={s.id}>{schoolPlace(s)} — your current school</Body>
        ) : (
          <Button
            key={s.id}
            label={schoolPlace(s)}
            accessibilityLabel={`Choose ${s.name}`}
            secondary
            disabled={busy}
            onPress={() => setChoosing(s)}
          />
        ),
      )}
      {choosing ? (
        <Notice>
          <Body>{chooseSchoolPrompt(data, choosing)}</Body>
          <Button
            label="Confirm"
            accessibilityLabel={`Confirm ${choosing.name}`}
            busy={busy}
            onPress={() =>
              void onChoose(choosing).then((ok) => {
                if (ok) {
                  setChoosing(null);
                  setResults(null);
                  setText('');
                }
              })
            }
          />
          <Button label="Cancel" secondary disabled={busy} onPress={() => setChoosing(null)} />
        </Notice>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Promo codes
// ---------------------------------------------------------------------------------------------

const PLAN_OPTIONS: readonly { value: string; label: string }[] = [
  { value: '', label: 'My current plan' },
  ...priceTable().map((tier) => ({
    value: String(tier.paidSlots),
    label: `${tier.paidSlots} ${tier.paidSlots === 1 ? 'child' : 'children'} · ${formatUsd(tier.cents)}`,
  })),
];

function PromoCard({ api, onRedeemed }: { api: ApiClient; onRedeemed: () => void }) {
  const channel = useMemo(() => channelForPlatform(devicePlatform()), []);
  const [code, setCode] = useState('');
  const [plan, setPlan] = useState('');
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<PromoProblem | null>(null);
  const [preview, setPreview] = useState<{
    request: PromoRequest;
    quote: PromoQuote;
    key: string;
  } | null>(null);
  const [result, setResult] = useState<PromoRedemption | null>(null);

  if (!channel) {
    return (
      <Card>
        <Heading>Monthly promo code</Heading>
        <Body>Check promo codes in the parent portal on the web, or in the app on your phone.</Body>
      </Card>
    );
  }

  const check = async () => {
    setProblem(null);
    setPreview(null);
    setResult(null);
    const request: PromoRequest = {
      code,
      channel,
      ...(plan === '' ? {} : { paidSlots: Number(plan) }),
    };
    setChecking(true);
    const outcome = await quotePromo(api, request);
    setChecking(false);
    if (outcome.ok) {
      // One idempotency key per previewed quote, reused for any retry of its redemption.
      setPreview({ request, quote: outcome.quote, key: randomUUID() });
    } else {
      setProblem(outcome.problem);
    }
  };

  return (
    <Card>
      <Heading>Monthly promo code</Heading>
      <Body>
        A code covers one monthly billing period only. Enter a new code each month for another
        discounted month — codes never carry forward, and without a new code your next renewal is
        your regular price.
      </Body>
      <Text style={styles.label} nativeID="promo-code-label">
        Promo code
      </Text>
      <TextInput
        style={styles.input}
        value={code}
        maxLength={24}
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="off"
        accessibilityLabel="Promo code"
        accessibilityLabelledBy="promo-code-label"
        onChangeText={(value) => {
          setCode(value);
          setProblem(null);
        }}
      />
      <Body muted>Billed by: {STORE_NAME[channel]} on this device.</Body>
      <Choice
        label="Plan size (only if you haven’t subscribed yet)"
        options={PLAN_OPTIONS}
        value={plan}
        onChange={setPlan}
      />
      <Button
        label={checking ? 'Checking…' : 'Check code'}
        busy={checking}
        onPress={() => void check()}
      />
      {problem ? <ErrorBox message={problem.message} needsPin={problem.needsPin} /> : null}
      {preview && !result ? (
        <QuotePreview
          api={api}
          preview={preview}
          onClose={() => setPreview(null)}
          onRedeemed={(r) => {
            setResult(r);
            setCode('');
            onRedeemed();
          }}
        />
      ) : null}
      {result ? (
        <Notice>
          <Heading>Redemption status</Heading>
          <Body>{STATE_LABEL[result.state]}</Body>
          {nextActionLine(result, display) ? <Body>{nextActionLine(result, display)}</Body> : null}
        </Notice>
      ) : null}
    </Card>
  );
}

function QuotePreview({
  api,
  preview,
  onClose,
  onRedeemed,
}: {
  api: ApiClient;
  preview: { request: PromoRequest; quote: PromoQuote; key: string };
  onClose: () => void;
  onRedeemed: (redemption: PromoRedemption) => void;
}) {
  const view = buildQuoteView(preview.quote, display);
  const [acknowledged, setAcknowledged] = useState(false);
  const [ackError, setAckError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<PromoProblem | null>(null);

  const redeem = async () => {
    if (!acknowledged) {
      setAckError(true);
      return;
    }
    setBusy(true);
    setProblem(null);
    const outcome = await redeemPromo(api, preview.request, preview.key);
    setBusy(false);
    if (outcome.ok) onRedeemed(outcome.redemption);
    else setProblem(outcome.problem);
  };

  return (
    <View
      style={[styles.card, { borderWidth: 2, borderColor: colors.teal }]}
      accessibilityLabel="Your code preview"
    >
      <Heading>{view.heading}</Heading>
      <Body>{view.periodLine}</Body>
      <Body>{view.onePeriodLine}</Body>
      {view.amounts.map((row) => (
        <Text key={row.label} style={styles.body}>
          <Text style={{ fontWeight: '800' }}>{row.label}: </Text>
          {row.value}
        </Text>
      ))}
      <Text style={[styles.body, { fontWeight: '800' }]}>{view.renewalLine}</Text>
      <Body>{view.previewLine}</Body>
      <Body>{view.donationLine}</Body>
      {view.redeem.available ? (
        <>
          <View style={[styles.row, { alignItems: 'center' }]}>
            <Switch
              value={acknowledged}
              onValueChange={(value) => {
                setAcknowledged(value);
                setAckError(false);
              }}
              accessibilityLabel="I understand this discount applies to one billing period only, and my store confirms the final amount"
            />
            <Body>I understand this discount applies to one billing period only.</Body>
          </View>
          {ackError ? <ErrorBox message="Please confirm you understand the terms above." /> : null}
          <Button
            label={busy ? 'Redeeming…' : 'Redeem code'}
            busy={busy}
            onPress={() => void redeem()}
          />
          <Button label="Cancel" secondary disabled={busy} onPress={onClose} />
          {problem ? <ErrorBox message={problem.message} needsPin={problem.needsPin} /> : null}
        </>
      ) : (
        <Notice>
          <Body>Not available yet. {view.redeem.reason}</Body>
          <Button label="Close preview" secondary onPress={onClose} />
        </Notice>
      )}
    </View>
  );
}

function HistoryCard({ api, version }: { api: ApiClient; version: number }) {
  // `version` changes after a redemption so the list reloads.
  const load = useCallback(() => loadPromoHistory(api), [api, version]);
  const { state, reload } = useLoad(load);
  return (
    <Card>
      <Heading>Your promo history</Heading>
      {state.status === 'idle' || state.status === 'loading' ? (
        <Loading label="Loading your promo history" />
      ) : null}
      {state.status === 'error' ? (
        <ErrorBox message={loadProblem(state.error).message} onRetry={() => void reload()} />
      ) : null}
      {state.status === 'ready' && state.data.redemptions.length === 0 ? (
        <Body>No promo codes used yet. Codes you use appear here with their status.</Body>
      ) : null}
      {state.status === 'ready'
        ? historyRows(state.data.redemptions, display).map((row) => (
            <View
              key={row.id}
              style={{ marginVertical: 8 }}
              accessible
              accessibilityLabel={`${row.title}. ${row.detail}. ${row.status}.${row.next ? ` ${row.next}` : ''}`}
            >
              <Text style={[styles.body, { fontWeight: '800' }]}>{row.title}</Text>
              <Body>{row.detail}</Body>
              <Body>{row.status}</Body>
              {row.next ? <Body muted>{row.next}</Body> : null}
            </View>
          ))
        : null}
      <Body muted>
        Amounts are what PencilLift previewed; your store receipt shows the final amount.
      </Body>
    </Card>
  );
}
