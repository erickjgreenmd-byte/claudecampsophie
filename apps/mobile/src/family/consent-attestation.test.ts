import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ATTESTATION_REQUIRED_COPY,
  CONSENT_ATTESTATION_STATEMENT,
  CONSENT_ATTESTATION_VERSION,
} from '@pencillift/contracts';

/**
 * Parental consent attestation (migration 0970). Every child profile carries an affirmation, made
 * by a named adult at a server-stamped instant, that they are that child's parent or legal
 * guardian. The affirmation is per child, so it is collected in the same submission as the child's
 * details and never carried over to a sibling.
 *
 * Both surfaces that can add a child must ask for it, in the same words, or the app has a door
 * with no lock on it (L-037: the same pre-check on every surface). The phone screen and the portal
 * page are read as source here because the Expo screens import react-native, which this pure-logic
 * suite cannot render (see vitest.config.ts) — and because the point of these checks is that the
 * wiring exists on BOTH, which a rendered test of one surface cannot show.
 */
const repo = join(import.meta.dirname, '..', '..', '..', '..');
const phone = readFileSync(join(repo, 'apps', 'mobile', 'app', '(parent)', 'children.tsx'), 'utf8');
const portal = readFileSync(
  join(repo, 'apps', 'web', 'src', 'pages', 'app', 'ChildrenPage.tsx'),
  'utf8',
);
const api = readFileSync(join(repo, 'apps', 'api', 'src', 'routes', 'family.ts'), 'utf8');
const migration = readFileSync(
  join(repo, 'supabase', 'migrations', '0970_parental_attestation.sql'),
  'utf8',
);

describe('the attestation statement is one wording, shared (0970)', () => {
  it('names the two things a court would ask about: who, and what they agreed to', () => {
    expect(CONSENT_ATTESTATION_STATEMENT).toMatch(/parent or legal guardian of this child/);
    expect(CONSENT_ATTESTATION_STATEMENT).toMatch(/Privacy Policy/);
    // The refusal says what to do, not merely that something is wrong.
    expect(ATTESTATION_REQUIRED_COPY).toMatch(/confirm you are this child/);
  });

  it('is versioned, so a later rewording is distinguishable from this one', () => {
    expect(CONSENT_ATTESTATION_VERSION).toMatch(/^\d{4}-\d{2}-v\d+$/);
  });

  it('is rendered from the contract on both surfaces, never retyped', () => {
    for (const [name, source] of [
      ['phone', phone],
      ['portal', portal],
    ] as const) {
      expect(source, name).toContain('CONSENT_ATTESTATION_STATEMENT');
      expect(source, name).toContain('ATTESTATION_REQUIRED_COPY');
      // A retyped copy would drift; the literal must appear in the contract only.
      expect(source, name).not.toMatch(/I am the parent or legal guardian of this child/);
    }
  });
});

describe('both surfaces collect the attestation before creating a child (0970)', () => {
  it('sends parentalAttestation with the child’s details, in one request', () => {
    for (const [name, source] of [
      ['phone', phone],
      ['portal', portal],
    ] as const) {
      expect(source, name).toMatch(/parentalAttestation: true/);
      // In the same object literal as the details, so no child can exist un-attested even briefly.
      expect(source, name).toMatch(/ageBand[,:][^}]*parentalAttestation: true/s);
    }
  });

  it('clears the tick after a success, so it never carries to a sibling', () => {
    expect(phone).toMatch(/setAttested\(false\)/);
    expect(portal).toMatch(/setAttested\(false\)/);
  });

  it('offers a real checkbox to assistive technology, not colour alone', () => {
    expect(phone).toMatch(/<Checkbox/);
    expect(portal).toMatch(/type="checkbox"/);
  });

  it('refuses with a reason rather than a dead control', () => {
    // A submit button disabled on the unticked box would leave the parent guessing, and would make
    // the refusal copy unreachable. Both surfaces keep the button live and explain.
    expect(portal).not.toMatch(/disabled=\{busy !== null \|\| !attested\}/);
    expect(phone).toMatch(/setAttestError\(attested \? null : ATTESTATION_REQUIRED_COPY\)/);
    expect(portal).toMatch(/setAttestError\(attested \? null : ATTESTATION_REQUIRED_COPY\)/);
  });
});

describe('the record is the server’s, not the client’s (0970)', () => {
  it('stamps the version, the instant and the adult server-side', () => {
    // Anchored to the child insert itself. Asserting that family.ts merely CONTAINS `deps.clock()`
    // passes on a route that dates the attestation from the request body, because other handlers in
    // the same file call the clock (L-054: a negative or unanchored assertion is weak by default).
    const insert =
      /insert into public\.child_profiles\s*\(([^)]*)\)\s*values\s*\(([\s\S]*?)\)\s*returning id/.exec(
        api,
      );
    expect(insert, 'the child insert must be findable').toBeTruthy();
    const [, columns, values] = insert as RegExpExecArray;
    expect(columns).toMatch(/attestation_version,\s*attested_at,\s*attested_by/);
    // Order matters: these three values fill those three columns, in this order.
    expect(values).toMatch(
      /\$\{CONSENT_ATTESTATION_VERSION\},\s*\$\{deps\.clock\(\)\},\s*\$\{parent\.userId\}/,
    );
    // Nothing the client sent can reach any of the three: not the instant, not the version, not
    // which adult it was recorded against.
    expect(values).not.toMatch(/body\.attest/i);
    expect(values).not.toMatch(/body\.parentalAttestation/);
  });

  it('is enforced by the database too, because authenticated reaches the table directly', () => {
    expect(migration).toMatch(/child_profiles_active_requires_attestation/);
    expect(migration).toMatch(/status <> 'active' or attested_at is not null/);
    // All three columns move together or not at all.
    expect(migration).toMatch(/child_profiles_attestation_complete/);
  });
});
