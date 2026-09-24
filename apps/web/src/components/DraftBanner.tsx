import { useId } from 'react';

/**
 * True only when the build records that the owner and legal counsel reviewed the public legal and
 * support pages (`VITE_LEGAL_REVIEWED=true`). Any other value, including a missing one, keeps the
 * draft label visible.
 *
 * Decision: only the exact string "true" counts. A typo or "1" fails safe to showing the draft
 * banner, because presenting an unreviewed draft as a final policy is the worse error.
 */
export function isLegalReviewed(env: Readonly<Record<string, unknown>> = import.meta.env): boolean {
  return env.VITE_LEGAL_REVIEWED === 'true';
}

/**
 * Labels a public page as a draft pending owner and legal review (spec P15 support, privacy and
 * deletion URLs). Render it first on the page, above the h1. It reads the environment at render
 * time so tests and builds can switch it off once review is recorded.
 */
export function DraftBanner() {
  const labelId = useId();
  if (isLegalReviewed()) return null;
  return (
    <div className="notice" role="note" aria-labelledby={labelId} style={{ marginBottom: 16 }}>
      <p style={{ margin: 0 }}>
        <strong id={labelId}>Draft for review.</strong> This page is a draft pending owner and legal
        review. It describes how PencilLift is designed to work and is not yet a final policy or
        agreement.
      </p>
    </div>
  );
}
