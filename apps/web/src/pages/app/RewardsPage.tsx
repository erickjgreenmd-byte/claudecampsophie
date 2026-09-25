import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  POINTS_ADJUSTMENT_MAX,
  POINTS_REASON_MAX_LENGTH,
  REWARD_INSTRUCTIONS_MAX_LENGTH,
  REWARD_POINT_COST_MAX,
  REWARD_RULE_MIN_RESPONSE_MS_MAX,
  REWARD_RULE_MIN_RESPONSE_MS_MIN,
  REWARD_RULE_POINTS_MAX,
  REWARD_TITLE_MAX_LENGTH,
  pointsAdjustmentResponseSchema,
  pointsHistoryResponseSchema,
  rewardDecisionResponseSchema,
  rewardResponseSchema,
  rewardRulesResponseSchema,
  rewardRulesUpdateResponseSchema,
  rewardTextContainsLink,
  rewardsOverviewResponseSchema,
  type FamilyRewardRules,
  type ParentRewardRequest,
  type PointsHistoryEntry,
  type PointsLedgerKind,
  type Reward,
  type RewardChildBalance,
  type RewardDecisionAction,
  type RewardRulesResponse,
  type RewardsOverview,
} from '@pencillift/contracts';
import { ApiRequestError } from '@pencillift/contracts/client';
import { ErrorState, Loading } from '../../components/states.tsx';
import { RequireParent, useApiQuery, useSession } from '../../lib/session.tsx';

/**
 * Parent rewards manager (spec P9, P14 "rewards manager" + "requests"; AC_REWARDS_03..05, AC_UX_02).
 * Points are a family motivation tool: parents give rewards themselves, outside the app. Every
 * change here needs a recent parent-PIN step-up, which the API enforces; this page explains how to
 * get one instead of failing silently.
 */
export default function RewardsPage() {
  return (
    <RequireParent>
      <RewardsManager />
    </RequireParent>
  );
}

// ---------------------------------------------------------------------------------------------
// Action feedback (shared by every form/button on the page)
// ---------------------------------------------------------------------------------------------

type Feedback = { kind: 'success'; message: string } | { kind: 'error'; error: ApiRequestError };

function toApiError(error: unknown): ApiRequestError {
  return error instanceof ApiRequestError
    ? error
    : new ApiRequestError('INTERNAL', 'Something went wrong. Please try again.', 0);
}

/** Runs one mutation at a time per section and records its outcome for display. */
function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const run = useCallback(async (key: string, action: () => Promise<string>) => {
    setBusy(key);
    setFeedback(null);
    try {
      const message = await action();
      setFeedback({ kind: 'success', message });
      return true;
    } catch (error) {
      setFeedback({ kind: 'error', error: toApiError(error) });
      return false;
    } finally {
      setBusy(null);
    }
  }, []);
  return { busy, feedback, run, setFeedback };
}

function ActionFeedback({ feedback }: { feedback: Feedback | null }) {
  if (!feedback) return null;
  if (feedback.kind === 'success') {
    return (
      <p role="status" style={{ color: 'var(--success)', fontWeight: 700 }}>
        {feedback.message}
      </p>
    );
  }
  if (feedback.error.code === 'STEP_UP_REQUIRED') {
    return (
      <div className="notice" role="alert">
        <p style={{ margin: 0 }}>
          <strong>Enter your parent PIN to continue.</strong> Changes to rewards and points need a
          recent PIN unlock. <Link to="/app/security">Unlock on the Security page</Link>, then try
          again.
        </p>
      </div>
    );
  }
  return <ErrorState message={feedback.error.message} />;
}

function FieldError({ id, message }: { id: string; message: string | null }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" style={{ color: 'var(--danger)', margin: '4px 0 0' }}>
      {message}
    </p>
  );
}

const textareaStyle = {
  width: '100%',
  maxWidth: 420,
  minHeight: 88,
  fontSize: '1rem',
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid var(--muted)',
  fontFamily: 'inherit',
} as const;

const sectionStyle = { marginTop: 16 } as const;
const buttonRow = { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 } as const;

function pointsLabel(points: number): string {
  return `${points} ${Math.abs(points) === 1 ? 'point' : 'points'}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function newId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------------------------

function RewardsManager() {
  const query = useApiQuery((api) => api.get('/v1/rewards', rewardsOverviewResponseSchema), []);
  // Keep the last good data on screen while refreshing so forms and messages are not lost.
  const [snapshot, setSnapshot] = useState<RewardsOverview | null>(null);
  const [historyChild, setHistoryChild] = useState<RewardChildBalance | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const { reload } = query;
  const ready = query.status === 'ready' ? query.data : null;
  useEffect(() => {
    if (ready) setSnapshot(ready);
  }, [ready]);

  const refresh = useCallback(() => {
    reload();
    setHistoryVersion((v) => v + 1);
  }, [reload]);

  const data = ready ?? snapshot;

  return (
    <>
      <h1>Rewards</h1>
      <p>
        Points are a family motivation tool, not money. You choose the rewards and give them
        yourself, outside the app. PencilLift never pays, buys or transfers anything.
      </p>
      {data === null && query.status === 'loading' ? <Loading label="Loading rewards…" /> : null}
      {query.status === 'error' ? (
        <ErrorState
          message={
            data
              ? `We couldn’t refresh rewards. ${query.error.message}`
              : query.error.code === 'NOT_FOUND'
                ? 'Create your family first, then come back to set up rewards.'
                : query.error.message
          }
          onRetry={query.reload}
        />
      ) : null}
      {data ? (
        <div aria-busy={query.status === 'loading'}>
          <RequestsSection data={data} onChanged={refresh} />
          <BalancesSection
            childBalances={data.children}
            selected={historyChild?.childId ?? null}
            onShowHistory={setHistoryChild}
          />
          {historyChild ? <HistorySection child={historyChild} version={historyVersion} /> : null}
          {activeChildren(data.children).length > 0 ? (
            <AdjustmentSection childBalances={activeChildren(data.children)} onChanged={refresh} />
          ) : null}
          <RewardsSection data={data} onChanged={refresh} />
          <RulesSection />
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Requests (approve / decline / fulfil / cancel)
// ---------------------------------------------------------------------------------------------

const STATE_LABEL: Record<ParentRewardRequest['state'], string> = {
  pending: 'Waiting for you',
  approved: 'Approved – give it when you can',
  fulfilled: 'Given',
  declined: 'Declined – points returned',
  cancelled: 'Cancelled – points returned',
};

const DECISION_DONE: Record<RewardDecisionAction, string> = {
  approve: 'Approved',
  decline: 'Declined',
  fulfill: 'Marked as given:',
  cancel: 'Cancelled',
};

/**
 * True when the server refused a decision because the request is no longer where this page thinks
 * it is (the child cancelled on their device, another guardian decided, or it was removed).
 */
function requestChangedElsewhere(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    ((error.code === 'BUSINESS_RULE' && error.rule === 'INVALID_TRANSITION') ||
      error.code === 'NOT_FOUND')
  );
}

function RequestsSection({ data, onChanged }: { data: RewardsOverview; onChanged: () => void }) {
  const { api } = useSession();
  const { busy, feedback, run } = useAction();
  const headingId = useId();

  const decide = (request: ParentRewardRequest, action: RewardDecisionAction) =>
    void run(`${request.id}:${action}`, async () => {
      try {
        await api.send(
          'POST',
          `/v1/reward-requests/${request.id}/decision`,
          { action },
          rewardDecisionResponseSchema,
        );
      } catch (error) {
        // Decision (RV-rewards-7): reload so a request that already changed stops offering buttons
        // that can only fail. The error stays on screen to explain what happened.
        if (requestChangedElsewhere(error)) onChanged();
        throw error;
      }
      onChanged();
      return `${DECISION_DONE[action]} ${request.childNickname}’s request for “${request.rewardTitle}”.`;
    });

  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>Reward requests</h2>
      <ActionFeedback feedback={feedback} />
      {data.openRequests.length === 0 ? (
        <p>No requests waiting. When a child asks for a reward, it appears here.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {data.openRequests.map((request) => {
            const who = `${request.childNickname}’s request`;
            const disabled = busy !== null;
            return (
              <li
                key={request.id}
                style={{ borderTop: '1px solid #e3e8ee', padding: '12px 0' }}
                aria-label={`${request.childNickname}: ${request.rewardTitle}`}
              >
                <p style={{ margin: 0 }}>
                  <strong>{request.childNickname}</strong> asked for{' '}
                  <strong>{request.rewardTitle}</strong> ({pointsLabel(request.pointCost)}) on{' '}
                  {formatDate(request.requestedAt)}.
                </p>
                <p style={{ margin: '4px 0 0' }}>Status: {STATE_LABEL[request.state]}</p>
                <div style={buttonRow}>
                  {request.state === 'pending' ? (
                    <>
                      <button
                        type="button"
                        className="btn"
                        disabled={disabled}
                        aria-label={`Approve ${who} for ${request.rewardTitle}`}
                        onClick={() => decide(request, 'approve')}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className="btn secondary"
                        disabled={disabled}
                        aria-label={`Decline ${who} for ${request.rewardTitle} and return the points`}
                        onClick={() => decide(request, 'decline')}
                      >
                        Decline
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="btn"
                        disabled={disabled}
                        aria-label={`Mark ${who} for ${request.rewardTitle} as given`}
                        onClick={() => decide(request, 'fulfill')}
                      >
                        Mark as given
                      </button>
                      <button
                        type="button"
                        className="btn secondary"
                        disabled={disabled}
                        aria-label={`Cancel ${who} for ${request.rewardTitle} and return the points`}
                        onClick={() => decide(request, 'cancel')}
                      >
                        Cancel and return points
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {data.recentRequests.length > 0 ? (
        <>
          <h3>Recently finished</h3>
          <ul>
            {data.recentRequests.map((request) => (
              <li key={request.id}>
                {request.childNickname} – {request.rewardTitle} ({pointsLabel(request.pointCost)}):{' '}
                {STATE_LABEL[request.state]}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Balances and history
// ---------------------------------------------------------------------------------------------

/**
 * Children who can take new rewards and point adjustments. Archived and draft profiles keep a
 * readable balance and history (spec P11) but are not offered in the forms (the API refuses new
 * rewards for them).
 */
function activeChildren(children: RewardChildBalance[]): RewardChildBalance[] {
  return children.filter((child) => child.status === 'active');
}

function BalancesSection({
  childBalances,
  selected,
  onShowHistory,
}: {
  childBalances: RewardChildBalance[];
  selected: string | null;
  onShowHistory: (child: RewardChildBalance) => void;
}) {
  const headingId = useId();
  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>Points balances</h2>
      {childBalances.length === 0 ? (
        <p>
          Points appear once a child is set up. <Link to="/app/children">Add a child</Link> to get
          started.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {childBalances.map((child) => (
            <li
              key={child.childId}
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 12,
                padding: '8px 0',
              }}
            >
              <strong>{child.nickname}</strong>
              <span>{pointsLabel(child.balance)}</span>
              {child.status === 'active' ? null : (
                <span style={{ color: 'var(--muted)' }}>
                  ({child.status === 'archived' ? 'archived' : 'no paid slot'} — history only)
                </span>
              )}
              <button
                type="button"
                className="btn secondary"
                aria-label={`View ${child.nickname}’s history`}
                aria-pressed={selected === child.childId}
                onClick={() => onShowHistory(child)}
              >
                View history
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const KIND_LABEL: Record<PointsLedgerKind, string> = {
  award: 'Earned for learning',
  adjustment: 'Parent adjustment',
  redemption_reserve: 'Set aside for a reward request',
  redemption_release: 'Returned from a reward request',
};

function historyDescription(entry: PointsHistoryEntry): string {
  const base = KIND_LABEL[entry.kind];
  return entry.rewardTitle ? `${base}: ${entry.rewardTitle}` : base;
}

/**
 * Older pages of the newest-first history (API-AUTH-R1-02). They stay attached only while the
 * first page still ends at the entry they were fetched before (`from`); a reload that moves that
 * entry drops them and offers "Show older" again, so no entry is skipped.
 */
interface OlderHistory {
  from: string;
  entries: PointsHistoryEntry[];
  nextCursor: string | null;
}

function HistorySection({ child, version }: { child: RewardChildBalance; version: number }) {
  const headingId = useId();
  const { api } = useSession();
  const historyPath = `/v1/points/history?childId=${encodeURIComponent(child.childId)}`;
  const history = useApiQuery(
    (client) => client.get(historyPath, pointsHistoryResponseSchema),
    [child.childId, version],
  );
  const [older, setOlder] = useState<OlderHistory | null>(null);
  const [olderBusy, setOlderBusy] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const firstCursor = history.status === 'ready' ? (history.data.nextCursor ?? null) : null;
  const attached = older !== null && older.from === firstCursor ? older : null;
  const nextCursor = attached ? attached.nextCursor : firstCursor;
  const seen = new Set<string>();
  const entries = (
    history.status === 'ready' ? [...history.data.entries, ...(attached?.entries ?? [])] : []
  ).filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));

  const showOlder = (from: string, cursor: string) =>
    void (async () => {
      setOlderBusy(true);
      setOlderError(null);
      try {
        const page = await api.get(
          `${historyPath}&before=${encodeURIComponent(cursor)}`,
          pointsHistoryResponseSchema,
        );
        setOlder((prev) => ({
          from,
          entries: [...(prev?.from === from ? prev.entries : []), ...page.entries],
          nextCursor: page.nextCursor ?? null,
        }));
      } catch (error) {
        setOlderError(
          error instanceof ApiRequestError ? error.message : 'Could not load older entries.',
        );
      } finally {
        setOlderBusy(false);
      }
    })();
  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>{child.nickname}’s points history</h2>
      {history.status === 'loading' ? <Loading label="Loading history…" /> : null}
      {history.status === 'error' ? (
        <ErrorState message={history.error.message} onRetry={history.reload} />
      ) : null}
      {history.status === 'ready' ? (
        <>
          <p>
            {history.data.totals.net === history.data.balance
              ? `History adds up to ${pointsLabel(history.data.totals.net)}, matching the balance.`
              : `History adds up to ${pointsLabel(history.data.totals.net)} but the balance shows ${pointsLabel(history.data.balance)}. Please contact support.`}{' '}
            Earned {history.data.totals.awarded}, adjusted {history.data.totals.adjustments}, set
            aside {history.data.totals.reserved}, returned {history.data.totals.released}.
          </p>
          {entries.length === 0 ? (
            <p>No points activity yet.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <caption style={{ textAlign: 'left', fontWeight: 700 }}>
                  Newest first{nextCursor !== null ? ` (latest ${entries.length} entries)` : ''}
                </caption>
                <thead>
                  <tr>
                    <th scope="col" style={{ textAlign: 'left' }}>
                      Date
                    </th>
                    <th scope="col" style={{ textAlign: 'left' }}>
                      What happened
                    </th>
                    <th scope="col" style={{ textAlign: 'right' }}>
                      Points
                    </th>
                    <th scope="col" style={{ textAlign: 'left' }}>
                      Reason
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={entry.id} style={{ borderTop: '1px solid #e3e8ee' }}>
                      <td>{formatDate(entry.createdAt)}</td>
                      <td>{historyDescription(entry)}</td>
                      <td style={{ textAlign: 'right' }}>
                        {entry.points > 0 ? `+${entry.points}` : String(entry.points)}
                      </td>
                      <td>{entry.reason ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {nextCursor !== null && firstCursor !== null ? (
            <p>
              <button
                type="button"
                className="btn secondary"
                disabled={olderBusy}
                onClick={() => showOlder(firstCursor, nextCursor)}
              >
                {olderBusy ? 'Loading older entries…' : 'Show older entries'}
              </button>
            </p>
          ) : null}
          {olderError ? <p role="alert">{olderError}</p> : null}
        </>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Adjustments
// ---------------------------------------------------------------------------------------------

type AdjustmentDirection = 'add' | 'remove';

const DIRECTION_OPTIONS: readonly { value: AdjustmentDirection; label: string }[] = [
  { value: 'add', label: 'Add points' },
  { value: 'remove', label: 'Remove points' },
];

function AdjustmentSection({
  childBalances,
  onChanged,
}: {
  childBalances: RewardChildBalance[];
  onChanged: () => void;
}) {
  const { api } = useSession();
  const { busy, feedback, run } = useAction();
  const headingId = useId();
  const ids = { child: useId(), points: useId(), hint: useId(), reason: useId(), error: useId() };
  const [childId, setChildId] = useState('');
  // Decision (RV-rewards-8): the direction is an explicit Add/Remove choice, because a phone's
  // numeric keypad (inputMode="numeric") has no minus key. The number field holds the size only.
  const [direction, setDirection] = useState<AdjustmentDirection>('add');
  const [points, setPoints] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  // One id per intended adjustment: a retry after a network error reuses it, so the server
  // applies the adjustment at most once. A fresh id is issued only after success.
  const [adjustmentId, setAdjustmentId] = useState(newId);

  const changePoints = (raw: string) => {
    // A sign typed on a full keyboard ("-3", "+3") picks the direction, which stays visible above.
    const signed = /^\s*([-−+])\s*(.*)$/u.exec(raw);
    if (signed) {
      setDirection(signed[1] === '+' ? 'add' : 'remove');
      setPoints(signed[2] ?? '');
    } else {
      setPoints(raw);
    }
    setAdjustmentId(newId());
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const size = Number(points.trim());
    const child = childBalances.find((c) => c.childId === childId);
    const trimmedReason = reason.trim();
    let issue: string | null = null;
    if (!child) issue = 'Choose a child.';
    else if (
      points.trim() === '' ||
      !Number.isInteger(size) ||
      size <= 0 ||
      size > POINTS_ADJUSTMENT_MAX
    )
      issue = `Enter a whole number other than 0 (up to ${POINTS_ADJUSTMENT_MAX}).`;
    else if (!/[\p{L}\p{N}]/u.test(trimmedReason))
      issue = 'Add a reason. It is saved with the adjustment in the points history.';
    setProblem(issue);
    if (issue || !child) return;
    const amount = direction === 'remove' ? -size : size;
    void run('adjust', async () => {
      const result = await api.send(
        'POST',
        '/v1/points/adjustments',
        { childId: child.childId, points: amount, reason: trimmedReason, adjustmentId },
        pointsAdjustmentResponseSchema,
      );
      setAdjustmentId(newId());
      setDirection('add');
      setPoints('');
      setReason('');
      onChanged();
      return result.applied
        ? `Saved. ${child.nickname} now has ${pointsLabel(result.balance)}.`
        : `That adjustment was already saved. ${child.nickname} has ${pointsLabel(result.balance)}.`;
    });
  };

  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>Adjust points</h2>
      <p>
        Add or remove points with a reason. Adjustments are added to the history; balances are never
        edited directly.
      </p>
      <form aria-label="Adjust points" onSubmit={submit} noValidate>
        <label htmlFor={ids.child}>Child</label>
        <select
          id={ids.child}
          value={childId}
          onChange={(e) => {
            setChildId(e.target.value);
            setAdjustmentId(newId());
          }}
        >
          <option value="">Choose a child</option>
          {childBalances.map((c) => (
            <option key={c.childId} value={c.childId}>
              {c.nickname}
            </option>
          ))}
        </select>
        <fieldset style={{ border: 0, padding: 0, margin: '12px 0 0' }}>
          <legend style={{ fontWeight: 700 }}>Add or remove</legend>
          {DIRECTION_OPTIONS.map((option) => (
            <label key={option.value} style={{ fontWeight: 400, display: 'flex', gap: 8 }}>
              <input
                type="radio"
                name={`${ids.points}-direction`}
                value={option.value}
                checked={direction === option.value}
                style={{ width: 'auto', minHeight: 24 }}
                onChange={() => {
                  setDirection(option.value);
                  setAdjustmentId(newId());
                }}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
        <label htmlFor={ids.points}>Points to add or remove</label>
        <p id={ids.hint} style={{ margin: 0, color: 'var(--muted)' }}>
          {direction === 'remove'
            ? 'Removing points. Enter how many as a whole number.'
            : 'Adding points. Enter how many as a whole number.'}
        </p>
        <input
          id={ids.points}
          inputMode="numeric"
          value={points}
          onChange={(e) => changePoints(e.target.value)}
          aria-describedby={ids.hint}
          aria-invalid={problem !== null && problem.startsWith('Enter')}
        />
        <label htmlFor={ids.reason}>Reason</label>
        <input
          id={ids.reason}
          value={reason}
          maxLength={POINTS_REASON_MAX_LENGTH}
          onChange={(e) => {
            setReason(e.target.value);
            setAdjustmentId(newId());
          }}
          aria-describedby={problem ? ids.error : undefined}
          aria-invalid={problem !== null && problem.startsWith('Add a reason')}
        />
        <FieldError id={ids.error} message={problem} />
        <ActionFeedback feedback={feedback} />
        <div style={buttonRow}>
          <button type="submit" className="btn" disabled={busy !== null}>
            Save adjustment
          </button>
        </div>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Reward catalog (create / edit / pause)
// ---------------------------------------------------------------------------------------------

function audienceLabel(reward: Reward, childBalances: RewardChildBalance[]): string {
  if (reward.childId === null) return 'for every child';
  const child = childBalances.find((c) => c.childId === reward.childId);
  return child ? `for ${child.nickname} only` : 'for one child';
}

function RewardsSection({ data, onChanged }: { data: RewardsOverview; onChanged: () => void }) {
  const headingId = useId();
  const [editing, setEditing] = useState<string | null>(null);
  const [saved, setSaved] = useState<Feedback | null>(null);
  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>Family rewards</h2>
      <ActionFeedback feedback={saved} />
      {data.rewards.length === 0 ? (
        <p>No rewards yet. Add one below – for example a trip to the park or choosing dinner.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {data.rewards.map((reward) => (
            <li key={reward.id} style={{ borderTop: '1px solid #e3e8ee', padding: '12px 0' }}>
              {editing === reward.id ? (
                <RewardForm
                  mode="edit"
                  reward={reward}
                  childBalances={activeChildren(data.children)}
                  onDone={(message) => {
                    setEditing(null);
                    setSaved({ kind: 'success', message });
                    onChanged();
                  }}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <>
                  <p style={{ margin: 0 }}>
                    <strong>{reward.title}</strong>
                    {reward.active ? '' : ' (paused – children can’t ask for it)'}
                  </p>
                  <p style={{ margin: '4px 0 0' }}>
                    {pointsLabel(reward.pointCost)} · {audienceLabel(reward, data.children)}
                  </p>
                  {reward.instructions ? (
                    <p style={{ margin: '4px 0 0', color: 'var(--muted)' }}>
                      {reward.instructions}
                    </p>
                  ) : null}
                  <div style={buttonRow}>
                    <button
                      type="button"
                      className="btn secondary"
                      aria-label={`Edit ${reward.title}`}
                      onClick={() => {
                        setSaved(null);
                        setEditing(reward.id);
                      }}
                    >
                      Edit
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <h3>Add a reward</h3>
      <RewardForm
        mode="create"
        childBalances={activeChildren(data.children)}
        onDone={(message) => {
          setSaved({ kind: 'success', message });
          onChanged();
        }}
      />
    </section>
  );
}

function RewardForm(
  props:
    | {
        mode: 'create';
        childBalances: RewardChildBalance[];
        onDone: (message: string) => void;
      }
    | {
        mode: 'edit';
        reward: Reward;
        childBalances: RewardChildBalance[];
        onDone: (message: string) => void;
        onCancel: () => void;
      },
) {
  const { api } = useSession();
  const { busy, feedback, run } = useAction();
  const initial = props.mode === 'edit' ? props.reward : null;
  const ids = {
    title: useId(),
    cost: useId(),
    audience: useId(),
    instructions: useId(),
    active: useId(),
    error: useId(),
  };
  const [title, setTitle] = useState(initial?.title ?? '');
  const [cost, setCost] = useState(initial ? String(initial.pointCost) : '');
  const [audience, setAudience] = useState('');
  const [instructions, setInstructions] = useState(initial?.instructions ?? '');
  const [active, setActive] = useState(initial?.active ?? true);
  const [problem, setProblem] = useState<string | null>(null);

  const validate = (): string | null => {
    const trimmed = title.trim();
    const amount = Number(cost.trim());
    if (!/[\p{L}\p{N}]/u.test(trimmed)) return 'Give the reward a name.';
    if (trimmed.length > REWARD_TITLE_MAX_LENGTH)
      return `Keep the name under ${REWARD_TITLE_MAX_LENGTH} characters.`;
    if (cost.trim() === '' || !Number.isInteger(amount) || amount < 1)
      return 'Points needed must be a whole number of at least 1.';
    if (amount > REWARD_POINT_COST_MAX)
      return `Points needed can be at most ${REWARD_POINT_COST_MAX}.`;
    // Decision: mirrors the API rule. Children see reward text, so it may not carry links.
    if (rewardTextContainsLink(trimmed) || rewardTextContainsLink(instructions))
      return 'Links aren’t allowed in rewards. Describe the reward in words instead.';
    return null;
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const issue = validate();
    setProblem(issue);
    if (issue) return;
    const trimmedTitle = title.trim();
    const pointCost = Number(cost.trim());
    const trimmedInstructions = instructions.trim();
    void run('save', async () => {
      if (props.mode === 'create') {
        await api.send(
          'POST',
          '/v1/rewards',
          {
            title: trimmedTitle,
            pointCost,
            childId: audience === '' ? null : audience,
            ...(trimmedInstructions === '' ? {} : { instructions: trimmedInstructions }),
          },
          rewardResponseSchema,
        );
        setTitle('');
        setCost('');
        setAudience('');
        setInstructions('');
        props.onDone(`Added “${trimmedTitle}”.`);
        return `Added “${trimmedTitle}”.`;
      }
      await api.send(
        'PATCH',
        `/v1/rewards/${props.reward.id}`,
        {
          title: trimmedTitle,
          pointCost,
          instructions: trimmedInstructions === '' ? null : trimmedInstructions,
          active,
        },
        rewardResponseSchema,
      );
      props.onDone(`Saved “${trimmedTitle}”.`);
      return `Saved “${trimmedTitle}”.`;
    });
  };

  const formName = props.mode === 'create' ? 'Add a reward' : `Edit ${props.reward.title}`;
  const describedBy = problem ? ids.error : undefined;
  let audienceField: ReactNode;
  if (props.mode === 'create') {
    audienceField = (
      <>
        <label htmlFor={ids.audience}>Who can ask for it</label>
        <select id={ids.audience} value={audience} onChange={(e) => setAudience(e.target.value)}>
          <option value="">Every child</option>
          {props.childBalances.map((c) => (
            <option key={c.childId} value={c.childId}>
              {c.nickname} only
            </option>
          ))}
        </select>
      </>
    );
  } else {
    audienceField = (
      <p style={{ margin: '12px 0 0' }}>
        Offered {audienceLabel(props.reward, props.childBalances)}.
      </p>
    );
  }

  return (
    <form aria-label={formName} onSubmit={submit} noValidate>
      <label htmlFor={ids.title}>Reward name</label>
      <input
        id={ids.title}
        value={title}
        maxLength={REWARD_TITLE_MAX_LENGTH}
        onChange={(e) => setTitle(e.target.value)}
        aria-describedby={describedBy}
      />
      <label htmlFor={ids.cost}>Points needed</label>
      <input
        id={ids.cost}
        inputMode="numeric"
        value={cost}
        onChange={(e) => setCost(e.target.value)}
        aria-describedby={describedBy}
      />
      {audienceField}
      <label htmlFor={ids.instructions}>Notes for your child (optional)</label>
      <textarea
        id={ids.instructions}
        value={instructions}
        maxLength={REWARD_INSTRUCTIONS_MAX_LENGTH}
        onChange={(e) => setInstructions(e.target.value)}
        style={textareaStyle}
      />
      {props.mode === 'edit' ? (
        <label htmlFor={ids.active} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            id={ids.active}
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            style={{ width: 24, minHeight: 24 }}
          />
          Children can ask for this reward
        </label>
      ) : null}
      <FieldError id={ids.error} message={problem} />
      <ActionFeedback feedback={feedback?.kind === 'error' ? feedback : null} />
      <div style={buttonRow}>
        <button type="submit" className="btn" disabled={busy !== null}>
          {props.mode === 'create' ? 'Add reward' : 'Save changes'}
        </button>
        {props.mode === 'edit' ? (
          <button type="button" className="btn secondary" onClick={props.onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// How points are earned (spec P9 "configurable earning rules"; AC_REWARDS_01)
// ---------------------------------------------------------------------------------------------

function secondsText(ms: number): string {
  const seconds = ms / 1000;
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

/** The published rules and caps as sentences, so no rule is shown as a bare number. */
function ruleSentences(rules: FamilyRewardRules): string[] {
  return [
    rules.attemptPoints > 0
      ? `${pointsLabel(rules.attemptPoints)} for each meaningful try at a practice question, even when the answer is wrong.`
      : 'A try on its own earns no points.',
    rules.independentCorrectBonus > 0
      ? `${pointsLabel(rules.independentCorrectBonus)} extra when the first try is right without help.`
      : 'No extra points for a right first try.',
    rules.setCompletionPoints > 0
      ? `${pointsLabel(rules.setCompletionPoints)} for finishing a daily practice set or weekly review with a real try at every question.`
      : 'No points for finishing a practice set.',
    `Blank answers, and answers given in under ${secondsText(rules.minMeaningfulResponseMs)}, earn nothing.`,
    'Each question earns its points once, and each set earns its finishing points once, however many times it is tried.',
  ];
}

function RulesSection() {
  const headingId = useId();
  const query = useApiQuery((api) => api.get('/v1/reward-rules', rewardRulesResponseSchema), []);
  // The rules returned by the last save; shown without another round trip.
  const [saved, setSaved] = useState<RewardRulesResponse | null>(null);
  const [editing, setEditing] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const data = saved ?? (query.status === 'ready' ? query.data : null);

  return (
    <section className="card" style={sectionStyle} aria-labelledby={headingId}>
      <h2 id={headingId}>How points are earned</h2>
      <p>
        Your family’s rules for practice points. Your children see them on their rewards screen. A
        change applies to points earned from then on; points already earned never change.
      </p>
      {data === null && query.status === 'loading' ? (
        <Loading label="Loading how points are earned…" />
      ) : null}
      {data === null && query.status === 'error' ? (
        <ErrorState message={query.error.message} onRetry={query.reload} />
      ) : null}
      {data ? (
        <>
          <ul>
            {ruleSentences(data.rules).map((sentence) => (
              <li key={sentence}>{sentence}</li>
            ))}
          </ul>
          <p style={{ color: 'var(--muted)' }}>
            {data.updatedAt === null
              ? 'These are the suggested starting rules.'
              : `Last changed on ${formatDate(data.updatedAt)}.`}
          </p>
          <ActionFeedback feedback={feedback} />
          {editing ? (
            <RulesForm
              current={data.rules}
              suggested={data.suggested}
              onSaved={(result, message) => {
                setSaved(result);
                setEditing(false);
                setFeedback({ kind: 'success', message });
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <div style={buttonRow}>
              <button
                type="button"
                className="btn secondary"
                onClick={() => {
                  setFeedback(null);
                  setEditing(true);
                }}
              >
                Change how points are earned
              </button>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}

type RuleField = keyof FamilyRewardRules;
type RuleValues = Record<RuleField, string>;
type RuleProblem = { field: RuleField; message: string };

const RULE_POINT_FIELDS: readonly {
  key: Exclude<RuleField, 'minMeaningfulResponseMs'>;
  label: string;
  hint: string;
}[] = [
  {
    key: 'attemptPoints',
    label: 'Points for each try',
    hint: 'Earned once per question for a real try, even when the answer is wrong.',
  },
  {
    key: 'independentCorrectBonus',
    label: 'Bonus when the first try is right',
    hint: 'Added once per question when the first try is right without help.',
  },
  {
    key: 'setCompletionPoints',
    label: 'Points for finishing a practice set',
    hint: 'Earned once per daily set or weekly review when every question had a real try.',
  },
];

function toRuleValues(rules: FamilyRewardRules): RuleValues {
  return {
    attemptPoints: String(rules.attemptPoints),
    independentCorrectBonus: String(rules.independentCorrectBonus),
    setCompletionPoints: String(rules.setCompletionPoints),
    minMeaningfulResponseMs: String(rules.minMeaningfulResponseMs / 1000),
  };
}

/** Mirrors the API contract (whole points 0–100; 0.5–60 s) so mistakes are explained before sending. */
function parseRuleValues(values: RuleValues): FamilyRewardRules | RuleProblem {
  const points: Partial<FamilyRewardRules> = {};
  for (const field of RULE_POINT_FIELDS) {
    const raw = values[field.key].trim();
    const amount = Number(raw);
    if (!/^\d+$/.test(raw) || amount > REWARD_RULE_POINTS_MAX) {
      return {
        field: field.key,
        message: `${field.label}: enter a whole number from 0 to ${REWARD_RULE_POINTS_MAX}.`,
      };
    }
    points[field.key] = amount;
  }
  const rawSeconds = values.minMeaningfulResponseMs.trim().replace(',', '.');
  const ms = Math.round(Number(rawSeconds) * 1000);
  if (
    rawSeconds === '' ||
    !Number.isFinite(ms) ||
    ms < REWARD_RULE_MIN_RESPONSE_MS_MIN ||
    ms > REWARD_RULE_MIN_RESPONSE_MS_MAX
  ) {
    return {
      field: 'minMeaningfulResponseMs',
      message: `Minimum answer time: enter a time from ${REWARD_RULE_MIN_RESPONSE_MS_MIN / 1000} to ${REWARD_RULE_MIN_RESPONSE_MS_MAX / 1000} seconds. It can’t be shorter, so quick guesses never earn points.`,
    };
  }
  return {
    attemptPoints: points.attemptPoints ?? 0,
    independentCorrectBonus: points.independentCorrectBonus ?? 0,
    setCompletionPoints: points.setCompletionPoints ?? 0,
    minMeaningfulResponseMs: ms,
  };
}

function RulesForm({
  current,
  suggested,
  onSaved,
  onCancel,
}: {
  current: FamilyRewardRules;
  suggested: FamilyRewardRules;
  onSaved: (rules: RewardRulesResponse, message: string) => void;
  onCancel: () => void;
}) {
  const { api } = useSession();
  const { busy, feedback, run } = useAction();
  const ids: Record<RuleField, string> = {
    attemptPoints: useId(),
    independentCorrectBonus: useId(),
    setCompletionPoints: useId(),
    minMeaningfulResponseMs: useId(),
  };
  const hintIds: Record<RuleField, string> = {
    attemptPoints: useId(),
    independentCorrectBonus: useId(),
    setCompletionPoints: useId(),
    minMeaningfulResponseMs: useId(),
  };
  const errorId = useId();
  const [values, setValues] = useState<RuleValues>(() => toRuleValues(current));
  const [problem, setProblem] = useState<RuleProblem | null>(null);

  const change = (field: RuleField, value: string) => setValues((v) => ({ ...v, [field]: value }));
  const describedBy = (field: RuleField) =>
    problem?.field === field ? `${hintIds[field]} ${errorId}` : hintIds[field];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseRuleValues(values);
    if ('field' in parsed) {
      setProblem(parsed);
      return;
    }
    setProblem(null);
    void run('save', async () => {
      const result = await api.send(
        'PUT',
        '/v1/reward-rules',
        parsed,
        rewardRulesUpdateResponseSchema,
      );
      const message = result.changed
        ? 'Saved. The new rules apply to points earned from now on; points already earned don’t change.'
        : 'No changes: these rules were already in place.';
      onSaved(
        { rules: result.rules, suggested: result.suggested, updatedAt: result.updatedAt },
        message,
      );
      return message;
    });
  };

  return (
    <form aria-label="Edit how points are earned" onSubmit={submit} noValidate>
      {RULE_POINT_FIELDS.map((field) => (
        <div key={field.key}>
          <label htmlFor={ids[field.key]}>{field.label}</label>
          <p id={hintIds[field.key]} style={{ margin: 0, color: 'var(--muted)' }}>
            {field.hint}
          </p>
          <input
            id={ids[field.key]}
            inputMode="numeric"
            value={values[field.key]}
            onChange={(e) => change(field.key, e.target.value)}
            aria-describedby={describedBy(field.key)}
            aria-invalid={problem?.field === field.key}
          />
        </div>
      ))}
      <label htmlFor={ids.minMeaningfulResponseMs}>Minimum answer time (seconds)</label>
      <p id={hintIds.minMeaningfulResponseMs} style={{ margin: 0, color: 'var(--muted)' }}>
        Blank answers, and answers faster than this, earn nothing. At least{' '}
        {secondsText(REWARD_RULE_MIN_RESPONSE_MS_MIN)}, so quick guesses can’t collect points.
      </p>
      <input
        id={ids.minMeaningfulResponseMs}
        inputMode="decimal"
        value={values.minMeaningfulResponseMs}
        onChange={(e) => change('minMeaningfulResponseMs', e.target.value)}
        aria-describedby={describedBy('minMeaningfulResponseMs')}
        aria-invalid={problem?.field === 'minMeaningfulResponseMs'}
      />
      <FieldError id={errorId} message={problem?.message ?? null} />
      <ActionFeedback feedback={feedback?.kind === 'error' ? feedback : null} />
      <div style={buttonRow}>
        <button type="submit" className="btn" disabled={busy !== null}>
          Save rules
        </button>
        <button
          type="button"
          className="btn secondary"
          onClick={() => {
            setValues(toRuleValues(suggested));
            setProblem(null);
          }}
        >
          Use the suggested rules
        </button>
        <button type="button" className="btn secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
