// The support screen imports react-native, which this vitest setup cannot render (see
// vitest.config.ts), so these checks read the screen source for the gate, the shared copy and the
// brand rules it must follow. Comments are stripped first so a comment cannot satisfy a check.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..', '..', 'app');
const supportScreen = readFileSync(join(appDir, '(parent)', 'support.tsx'), 'utf8');
const homeScreen = readFileSync(join(appDir, '(parent)', 'home.tsx'), 'utf8');

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('parent support screen (source checks)', () => {
  const src = code(supportScreen);

  it('goes through the parent-area gate like every other parent screen (AC_ACCESS_07)', () => {
    expect(/\buseParentAccess\s*\(/.test(src)).toBe(true);
    expect(src).toContain('<ParentAccessState access={access} />');
    expect(src).toMatch(/access\.status === 'ready' \? <SupportHome api=\{access\.api\} \/>/);
    // Never a second token source: parent data only through the shared gate's client.
    expect(src).not.toMatch(/TokenSource|createMobileApi/);
  });

  it('uses the shared intake and refund copy, never its own words about children or refunds', () => {
    expect(src).toContain('SUPPORT_INTAKE_NOTICE');
    expect(src).toContain('SUPPORT_REFUND_NOTICE');
    expect(src).not.toMatch(/PencilLift (will|can) refund/i);
  });

  it('takes every colour from the brand tokens (no hex literal, no named colour)', () => {
    expect(src).toMatch(/from '@pencillift\/ui-tokens'/);
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(
      /(?:backgroundColor|color|borderColor|borderLeftColor|borderTopColor):\s*'[a-z]+'/,
    );
  });

  it('caps what the parent can type at the contract lengths and shows the count', () => {
    expect(src).toContain('maxLength={SUPPORT_SUBJECT_MAX_LENGTH}');
    expect(src).toContain('maxLength={SUPPORT_MESSAGE_MAX_LENGTH}');
    expect(src).toContain('charactersLeft(');
  });

  it('never logs case text', () => {
    expect(src).not.toMatch(/console\./);
  });

  it('is reachable from the parent home', () => {
    expect(code(homeScreen)).toContain("'/(parent)/support'");
  });
});
