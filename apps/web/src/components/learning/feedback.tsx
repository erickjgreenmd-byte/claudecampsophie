import { useCallback, useState } from 'react';
import { Link } from 'react-router';
import { ApiRequestError } from '@pencillift/contracts/client';
import { ErrorState } from '../states.tsx';

/** Shared action feedback for the learning planner sections (one mutation at a time per section). */

export type Feedback =
  { kind: 'success'; message: string } | { kind: 'error'; error: ApiRequestError };

export function toApiError(error: unknown): ApiRequestError {
  return error instanceof ApiRequestError
    ? error
    : new ApiRequestError('INTERNAL', 'Something went wrong. Please try again.', 0);
}

export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const run = useCallback(async (key: string, action: () => Promise<string>) => {
    setBusy(key);
    setFeedback(null);
    try {
      setFeedback({ kind: 'success', message: await action() });
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

export function StepUpNotice({ what }: { what: string }) {
  return (
    <div className="notice" role="alert">
      <p style={{ margin: 0 }}>
        <strong>Enter your parent PIN to continue.</strong> {what} needs a recent PIN unlock.{' '}
        <Link to="/app/security">Unlock on the Security page</Link>, then try again.
      </p>
    </div>
  );
}

export function ActionFeedback({
  feedback,
  stepUpWhat,
}: {
  feedback: Feedback | null;
  stepUpWhat?: string;
}) {
  if (!feedback) return null;
  if (feedback.kind === 'success') {
    return (
      <p role="status" style={{ color: 'var(--success)', fontWeight: 700 }}>
        {feedback.message}
      </p>
    );
  }
  if (feedback.error.code === 'STEP_UP_REQUIRED') {
    return <StepUpNotice what={stepUpWhat ?? 'This action'} />;
  }
  if (feedback.error.code === 'RATE_LIMITED') {
    return (
      <ErrorState message="That was a lot of requests in a short time. Please wait a little, then try again." />
    );
  }
  return <ErrorState message={feedback.error.message} />;
}

export function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" style={{ color: 'var(--danger)', margin: '4px 0 0' }}>
      {message}
    </p>
  );
}

export const sectionStyle = { marginTop: 16 } as const;
export const buttonRow = { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 } as const;
export const listReset = { listStyle: 'none', padding: 0, margin: 0 } as const;
export const rowStyle = { borderTop: '1px solid #e3e8ee', padding: '12px 0' } as const;
export const hintStyle = { color: 'var(--muted)', margin: '4px 0 0' } as const;
export const textareaStyle = {
  width: '100%',
  maxWidth: 560,
  minHeight: 96,
  fontSize: '1rem',
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid var(--muted)',
  fontFamily: 'inherit',
} as const;
