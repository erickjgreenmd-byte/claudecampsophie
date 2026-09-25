import { useCallback, useState, type ReactNode } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { SupportCaseDetail } from '@pencillift/contracts';
import type { ApiClient } from '@pencillift/contracts/client';
import { colors, spacing, typography } from '@pencillift/ui-tokens';
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
  styles as ui,
  Title,
  useLoad,
  useParentAccess,
} from '../../src/family/ui.tsx';
import {
  loadBillingPeriods,
  loadSupportCase,
  loadSupportCases,
  openSupportCase,
  replyToCase,
  loadSupportPolicy,
} from '../../src/support/actions.ts';
import {
  billingPeriodOptions,
  caseRows,
  charactersLeft,
  EMPTY_CASES_COPY,
  EMPTY_DRAFT,
  KIND_HINTS,
  latestReplyLine,
  NO_PERIODS_COPY,
  periodLabel,
  refundLine,
  SUPPORT_INTAKE_NOTICE,
  SUPPORT_KIND_OPTIONS,
  SUPPORT_MESSAGE_MAX_LENGTH,
  SUPPORT_REFUND_NOTICE,
  SUPPORT_SUBJECT_MAX_LENGTH,
  supportProblem,
  threadEntries,
  type CaseDraft,
  type CaseRow,
  type DraftProblems,
  type SupportProblem,
} from '../../src/support/view-model.ts';

/**
 * Parent support: the family's cases with their status and thread, a new case (kind, subject,
 * message, and for a refund request one of the family's own billing periods), and replies while a
 * case is not closed. Cases are about the account, the plan or the app, never about a child: the
 * intake copy is shared with the web portal and the server caps lengths. Store refunds are issued
 * by the store, never by PencilLift, and a linked period shows only what the store reported.
 * Parent area only (useParentAccess): child mode never reaches this screen. Logic lives in
 * src/support (unit-tested); this file only wires it to React Native.
 */
export default function SupportScreen() {
  const access = useParentAccess();
  return (
    <Screen>
      <Title>Support</Title>
      <ParentAccessState access={access} />
      {access.status === 'ready' ? <SupportHome api={access.api} /> : null}
    </Screen>
  );
}

function SupportHome({ api }: { api: ApiClient }) {
  const load = useCallback(() => loadSupportCases(api), [api]);
  const { state, reload } = useLoad(load);
  const [expanded, setExpanded] = useState<string | null>(null);
  const now = new Date();

  return (
    <>
      <Body>
        Questions about your account, your plan or the app? Open a case and the PencilLift team
        replies here.
      </Body>

      <Heading>Your cases</Heading>
      {state.status === 'idle' || state.status === 'loading' ? (
        <Loading label="Loading your support cases" />
      ) : null}
      {state.status === 'error' ? (
        <ErrorBox
          message={supportProblem(state.error, 'load').message}
          onRetry={supportProblem(state.error, 'load').noFamily ? undefined : () => void reload()}
        />
      ) : null}
      {state.status === 'ready' && state.data.length === 0 ? <Body>{EMPTY_CASES_COPY}</Body> : null}
      {state.status === 'ready'
        ? caseRows(state.data, now).map((row) => (
            <CaseCard
              key={row.id}
              api={api}
              row={row}
              expanded={expanded === row.id}
              onToggle={() => setExpanded(expanded === row.id ? null : row.id)}
              onChanged={() => void reload()}
            />
          ))
        : null}
      {state.status === 'ready' ? (
        <Button label="Refresh cases" secondary onPress={() => void reload()} />
      ) : null}

      <NewCaseForm
        api={api}
        onOpened={(detail) => {
          setExpanded(detail.id);
          void reload();
        }}
      />
    </>
  );
}

function CaseCard({
  api,
  row,
  expanded,
  onToggle,
  onChanged,
}: {
  api: ApiClient;
  row: CaseRow;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  return (
    <View style={[ui.card, row.needsYou ? local.attention : null]}>
      <Text style={local.subject} accessibilityLabel={row.accessibilityLabel}>
        {row.subject}
      </Text>
      <Body muted>
        {row.kindLabel} · {row.openedLine} · {row.repliesLine}
      </Body>
      <Text style={ui.body}>
        {row.needsYou ? <Text style={local.strong}>Needs your reply · </Text> : null}
        Status: {row.statusLabel}
      </Text>
      <Body muted>{row.statusNote}</Body>
      {row.outcomeLine ? <Body>{row.outcomeLine}</Body> : null}
      <Button
        label={expanded ? 'Hide details' : 'Show details'}
        accessibilityLabel={`${expanded ? 'Hide' : 'Show'} details of ${row.subject}`}
        secondary
        onPress={onToggle}
      />
      {expanded ? <CaseThread api={api} id={row.id} onChanged={onChanged} /> : null}
    </View>
  );
}

function CaseThread({ api, id, onChanged }: { api: ApiClient; id: string; onChanged: () => void }) {
  const load = useCallback(() => loadSupportCase(api, id), [api, id]);
  const { state, reload } = useLoad(load);
  const [replied, setReplied] = useState<SupportCaseDetail | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<SupportProblem | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const now = new Date();

  const detail = replied ?? (state.status === 'ready' ? state.data : null);
  if (!detail) {
    if (state.status === 'error') {
      const p = supportProblem(state.error, 'case');
      return <ErrorBox message={p.message} onRetry={() => void reload()} />;
    }
    return <Loading label="Loading this case" />;
  }

  const send = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    setSent(null);
    const result = await replyToCase(api, id, text, detail.status);
    setBusy(false);
    if (result.ok) {
      setText('');
      setReplied(result.detail);
      setSent(result.message);
      onChanged();
    } else {
      setProblem(result.problem);
    }
  };

  const latest = latestReplyLine(detail, now);
  return (
    <View>
      {detail.billingPeriod ? (
        <View style={local.period}>
          <Text style={local.strong}>Billing period on this case</Text>
          <Body>{periodLabel(detail.billingPeriod)}</Body>
          <Body>{refundLine(detail.billingPeriod)}</Body>
          {detail.kind === 'refund_request' ? <Body muted>{SUPPORT_REFUND_NOTICE}</Body> : null}
        </View>
      ) : null}
      {latest ? <Body muted>{latest}</Body> : null}
      {threadEntries(detail, now).map((entry) => (
        <View
          key={entry.id}
          style={[local.entry, entry.author === 'PencilLift support' ? local.staffEntry : null]}
        >
          <Text style={local.strong}>
            {entry.author} · {entry.when}
            {entry.isLatestReply ? ' · Latest reply' : ''}
          </Text>
          <Body>{entry.body}</Body>
        </View>
      ))}
      {detail.canReply ? (
        <>
          <Text style={ui.label} nativeID="support-reply-label">
            Reply
          </Text>
          <Body muted>{SUPPORT_INTAKE_NOTICE}</Body>
          <TextInput
            style={[ui.input, local.multiline]}
            value={text}
            multiline
            maxLength={SUPPORT_MESSAGE_MAX_LENGTH}
            textAlignVertical="top"
            accessibilityLabel="Reply"
            accessibilityLabelledBy="support-reply-label"
            onChangeText={(value) => {
              setText(value);
              setProblem(null);
            }}
          />
          <Body muted>{charactersLeft(text, SUPPORT_MESSAGE_MAX_LENGTH)}</Body>
          <Button
            label={busy ? 'Sending…' : 'Send reply'}
            busy={busy}
            onPress={() => void send()}
          />
          {problem ? <ErrorBox message={problem.message} needsPin={problem.needsPin} /> : null}
          {sent ? <SuccessNote>{sent}</SuccessNote> : null}
        </>
      ) : null}
    </View>
  );
}

function NewCaseForm({
  api,
  onOpened,
}: {
  api: ApiClient;
  onOpened: (detail: SupportCaseDetail) => void;
}) {
  const [draft, setDraft] = useState<CaseDraft>(EMPTY_DRAFT);
  const [problems, setProblems] = useState<DraftProblems>({});
  const [problem, setProblem] = useState<SupportProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const update = (patch: Partial<CaseDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setProblems({});
    setProblem(null);
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setProblems({});
    setProblem(null);
    setDone(null);
    const result = await openSupportCase(api, draft);
    setBusy(false);
    if (result.ok) {
      setDraft(EMPTY_DRAFT);
      setDone(result.message);
      onOpened(result.detail);
    } else if (result.reason === 'fields') {
      setProblems(result.problems);
    } else {
      setProblem(result.problem);
    }
  };

  return (
    <Card>
      <Heading>Open a new case</Heading>
      <Body>{SUPPORT_INTAKE_NOTICE}</Body>
      <Choice
        label="What is it about?"
        options={SUPPORT_KIND_OPTIONS}
        value={draft.kind}
        onChange={(kind) => update({ kind })}
      />
      <Body muted>{KIND_HINTS[draft.kind]}</Body>
      {draft.kind === 'refund_request' ? (
        <RefundPeriodPicker
          api={api}
          value={draft.billingPeriodId}
          onChange={(billingPeriodId) => update({ billingPeriodId })}
        />
      ) : null}

      <Text style={ui.label} nativeID="support-subject-label">
        Subject
      </Text>
      <TextInput
        style={ui.input}
        value={draft.subject}
        maxLength={SUPPORT_SUBJECT_MAX_LENGTH}
        accessibilityLabel="Subject"
        accessibilityLabelledBy="support-subject-label"
        onChangeText={(subject) => update({ subject })}
      />
      {problems.subject ? <FieldProblem>{problems.subject}</FieldProblem> : null}

      <Text style={ui.label} nativeID="support-message-label">
        Message
      </Text>
      <TextInput
        style={[ui.input, local.multiline]}
        value={draft.message}
        multiline
        maxLength={SUPPORT_MESSAGE_MAX_LENGTH}
        textAlignVertical="top"
        accessibilityLabel="Message"
        accessibilityLabelledBy="support-message-label"
        onChangeText={(message) => update({ message })}
      />
      <Body muted>{charactersLeft(draft.message, SUPPORT_MESSAGE_MAX_LENGTH)}</Body>
      {problems.message ? <FieldProblem>{problems.message}</FieldProblem> : null}

      <Button
        label={busy ? 'Sending…' : 'Send to PencilLift'}
        busy={busy}
        onPress={() => void submit()}
      />
      {problem ? <ErrorBox message={problem.message} needsPin={problem.needsPin} /> : null}
      {done ? <SuccessNote>{done}</SuccessNote> : null}
    </Card>
  );
}

/** The family's own billing periods for a refund request; the store issues the refund. */
function RefundPeriodPicker({
  api,
  value,
  onChange,
}: {
  api: ApiClient;
  value: string;
  onChange: (id: string) => void;
}) {
  const load = useCallback(() => loadBillingPeriods(api), [api]);
  const { state, reload } = useLoad(load);
  // The owner's refund window (Owner action #32): stated when known, silently absent otherwise.
  const loadPolicy = useCallback(() => loadSupportPolicy(api), [api]);
  const { state: policy } = useLoad(loadPolicy);
  return (
    <Notice>
      <Body>{SUPPORT_REFUND_NOTICE}</Body>
      {policy.status === 'ready' ? <Body muted>{policy.data.refundWindowSentence}</Body> : null}
      {state.status === 'idle' || state.status === 'loading' ? (
        <Loading label="Loading your billing periods" />
      ) : null}
      {state.status === 'error' ? (
        <ErrorBox
          message="We couldn’t load your billing periods. You can still send the request without one."
          onRetry={() => void reload()}
        />
      ) : null}
      {state.status === 'ready' && state.data.length === 0 ? <Body>{NO_PERIODS_COPY}</Body> : null}
      {state.status === 'ready' && state.data.length > 0 ? (
        <Choice
          label="Which billing period?"
          options={billingPeriodOptions(state.data)}
          value={value}
          onChange={onChange}
        />
      ) : null}
    </Notice>
  );
}

function FieldProblem({ children }: { children: ReactNode }) {
  return (
    <Text accessibilityRole="alert" style={local.problem}>
      {children}
    </Text>
  );
}

function SuccessNote({ children }: { children: ReactNode }) {
  return (
    <View accessibilityLiveRegion="polite" style={[ui.card, local.ok]}>
      <Body>{children}</Body>
    </View>
  );
}

const local = StyleSheet.create({
  subject: { fontSize: typography.scale.md, fontWeight: '800', color: colors.navy },
  strong: { fontSize: typography.scale.md, fontWeight: '800', color: colors.navy },
  // Gold = attention: a case waiting on the parent (also said in text).
  attention: { borderLeftWidth: 4, borderLeftColor: colors.gold },
  ok: { borderLeftWidth: 4, borderLeftColor: colors.success },
  period: {
    borderTopWidth: 1,
    borderTopColor: colors.muted,
    paddingTop: spacing.sm,
    marginTop: spacing.sm,
  },
  entry: {
    borderLeftWidth: 3,
    borderLeftColor: colors.muted,
    paddingLeft: spacing.sm,
    marginVertical: spacing.xs,
  },
  staffEntry: { borderLeftColor: colors.teal },
  multiline: {
    minHeight: 120,
    paddingVertical: spacing.sm,
    fontSize: typography.scale.md,
  },
  // Danger red only for a problem the parent must fix.
  problem: { color: colors.danger, fontSize: typography.scale.sm, marginTop: spacing.xs },
});
