import { useEffect, useId, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  formatEffectiveDate,
  isLegalReviewed,
  readLegalConfig,
  type LegalConfig,
} from '../../lib/config.ts';

/**
 * Shared building blocks for the public site (spec P14 public screens). Styling uses the CSS
 * variables in styles.css so brand colours and contrast stay in one place.
 */

/**
 * The mailbox shown while the owner has not confirmed one. It is plain text marked "to be
 * confirmed", never a mailto link, so nobody relies on an inbox that may not be monitored yet for
 * urgent, privacy or deletion requests. A reviewed build shows `VITE_SUPPORT_EMAIL` instead.
 */
export const PLACEHOLDER_SUPPORT_EMAIL = 'support@pencillift.com';
/** @deprecated Use {@link PLACEHOLDER_SUPPORT_EMAIL}; kept for existing imports. */
export const SUPPORT_EMAIL = PLACEHOLDER_SUPPORT_EMAIL;

/**
 * The legal configuration as the page copy sees it. The startup gate in lib/config.ts has already
 * thrown for a reviewed build that lacks a date or a mailbox, so a real build never reaches the
 * fallback; it exists for tests that stub only `VITE_LEGAL_REVIEWED`, where the copy fails safe to
 * the draft wording for the missing value.
 */
export function legalState(env: Readonly<Record<string, unknown>> = import.meta.env): LegalConfig {
  try {
    return readLegalConfig(env);
  } catch {
    return { reviewed: isLegalReviewed(env), effectiveDate: null, supportEmail: null };
  }
}

/** Renders its children only while the page is a draft (legal review not recorded). */
export function DraftOnly({ children }: { children: ReactNode }) {
  return isLegalReviewed() ? null : <>{children}</>;
}

/** Renders its children only once legal review is recorded in the build. */
export function ReviewedOnly({ children }: { children: ReactNode }) {
  return isLegalReviewed() ? <>{children}</> : null;
}

/** "draft " while a draft, "" once reviewed; for link text such as "Read the draft privacy policy". */
export function draftPrefix(): string {
  return isLegalReviewed() ? '' : 'draft ';
}

/**
 * The support mailbox. Reviewed build: the confirmed mailbox as a mailto link. Draft build: the
 * configured or placeholder address as plain text marked "to be confirmed".
 */
export function SupportEmail() {
  const { reviewed, supportEmail } = legalState();
  if (reviewed && supportEmail) {
    return <a href={`mailto:${supportEmail}`}>{supportEmail}</a>;
  }
  return (
    <>
      <strong>{supportEmail ?? PLACEHOLDER_SUPPORT_EMAIL}</strong> (to be confirmed)
    </>
  );
}

/** The status line under a legal page's h1: the effective date once reviewed, else the draft note. */
export function LegalStatus() {
  const { reviewed, effectiveDate } = legalState();
  if (reviewed && effectiveDate) {
    return (
      <p style={muted}>
        Effective date: <time dateTime={effectiveDate}>{formatEffectiveDate(effectiveDate)}</time>.
      </p>
    );
  }
  return <p style={muted}>Status: draft, not yet in effect. Effective date to be confirmed.</p>;
}

/**
 * The three payment channels, named together wherever the legal pages name any of them (AMZ-17):
 * Apple's App Store (iPhone, iPad), Google Play (Android) and the Amazon Appstore (Fire tablets).
 */
export const PAYMENT_STORES =
  'the App Store or Google Play (or the Amazon Appstore on a Fire tablet)';

/** The six launch subjects (spec P1), in the order the product presents them. */
export const SUBJECTS = [
  'Math',
  'Reading comprehension',
  'Spelling and vocabulary',
  'Grammar and writing',
  'Science',
  'Social studies',
] as const;

export function SubjectList() {
  return (
    <ul role="list" aria-label="Supported subjects" style={chipList}>
      {SUBJECTS.map((subject) => (
        <li key={subject} style={chip}>
          {subject}
        </li>
      ))}
    </ul>
  );
}

/**
 * Sets the browser tab title (WCAG 2.4.2) and restores the previous one on unmount.
 *
 * Decision: an effect instead of a React 19 `<title>` element. index.html ships a static title,
 * and a hoisted `<title>` adopts or displaces it and removes it on unmount, which would leave
 * later non-public pages with no tab title at all.
 */
export function PageTitle({ title }: { title: string }) {
  useEffect(() => {
    const previous = document.title;
    document.title = `${title} · PencilLift`;
    return () => {
      document.title = previous;
    };
  }, [title]);
  return null;
}

/** A titled region: `<section>` labelled by its own h2, so it is a navigable landmark. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} style={{ marginTop: 32 }}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

/**
 * A prominent link styled as a button. The primary fill uses the darker teal (`--teal-text`) so
 * white text keeps at least 4.5:1 contrast.
 */
export function CtaLink({
  to,
  children,
  variant = 'primary',
}: {
  to: string;
  children: ReactNode;
  variant?: 'primary' | 'secondary';
}) {
  const style: CSSProperties =
    variant === 'primary'
      ? { ...ctaBase, background: 'var(--teal-text)', color: 'var(--white)' }
      : { ...ctaBase, background: 'var(--white)', color: 'var(--teal-text)' };
  return (
    <Link to={to} style={style}>
      {children}
    </Link>
  );
}

const ctaBase: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: 44,
  padding: '10px 20px',
  borderRadius: '100vmax',
  border: '2px solid var(--teal-text)',
  fontWeight: 800,
  textDecoration: 'none',
};

export const ctaRow: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 12,
  marginTop: 16,
};

/** Responsive card grid: one column on phones, more as space allows, with no media queries. */
export const cardGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))',
  gap: 16,
  listStyle: 'none',
  padding: 0,
  margin: 0,
};

export const lead: CSSProperties = { fontSize: '1.2rem', maxWidth: '44rem' };

export const muted: CSSProperties = { color: 'var(--muted)' };

const chipList: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
  listStyle: 'none',
  padding: 0,
  margin: '12px 0',
};

const chip: CSSProperties = {
  background: 'var(--white)',
  border: '1px solid var(--teal-text)',
  borderRadius: '100vmax',
  padding: '6px 14px',
  fontWeight: 700,
};
