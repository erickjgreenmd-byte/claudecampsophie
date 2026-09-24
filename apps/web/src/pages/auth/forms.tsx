import { useState, type FormEvent, type ReactNode } from 'react';
import type { AuthOutcome } from '../../lib/auth.ts';

/** Shared form shell for account pages: one submit at a time, a polite status and an alert on error. */
export function AccountForm({
  title,
  submitLabel,
  onSubmit,
  children,
  done,
}: {
  title: string;
  submitLabel: string;
  onSubmit: () => Promise<AuthOutcome>;
  children: ReactNode;
  done?: (outcome: Extract<AuthOutcome, { ok: true }>) => ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Extract<AuthOutcome, { ok: true }> | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await onSubmit();
      if (outcome.ok) setResult(outcome);
      else setError(outcome.message);
    } catch {
      setError('Something went wrong. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  if (result && done) return <>{done(result)}</>;
  return (
    <section className="card" aria-labelledby="account-form-title">
      <h1 id="account-form-title">{title}</h1>
      <form onSubmit={(e) => void submit(e)} noValidate>
        {children}
        {error ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : null}
        <button type="submit" className="btn" disabled={busy} aria-busy={busy}>
          {busy ? 'Please wait…' : submitLabel}
        </button>
      </form>
    </section>
  );
}

export function Field({
  id,
  label,
  type,
  value,
  onChange,
  autoComplete,
  hint,
}: {
  id: string;
  label: string;
  type: 'email' | 'password' | 'text';
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  hint?: string;
}) {
  return (
    <p>
      <label htmlFor={id}>{label}</label>
      <br />
      <input
        id={id}
        type={type}
        value={value}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={hint ? `${id}-hint` : undefined}
        required
      />
      {hint ? (
        <>
          <br />
          <small id={`${id}-hint`}>{hint}</small>
        </>
      ) : null}
    </p>
  );
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
