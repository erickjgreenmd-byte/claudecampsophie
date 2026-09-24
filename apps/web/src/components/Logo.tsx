/**
 * Text lockup placeholder that follows the approved wordmark colours (navy "Pencil", teal "Lift").
 * The traced vector symbol from brand/approved_logo_reference.png is a pending brand asset
 * (docs/Release_Readiness.md); this is not presented as the final artwork.
 */
export function Logo({ tagline = false }: { tagline?: boolean }) {
  return (
    <span
      aria-label="PencilLift"
      style={{ fontWeight: 900, fontSize: '1.6rem', letterSpacing: '-0.5px' }}
    >
      <span style={{ color: 'var(--navy)' }}>Pencil</span>
      <span style={{ color: 'var(--teal-text)' }}>Lift</span>
      {tagline ? (
        <span
          style={{ display: 'block', fontSize: '0.95rem', fontWeight: 700, color: 'var(--navy)' }}
        >
          Turn homework into progress.
        </span>
      ) : null}
    </span>
  );
}
