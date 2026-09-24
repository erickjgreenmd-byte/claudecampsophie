// Test-only helpers for the answer-guard specs. Synthetic data only (spec P3: Riley, Sam).
import { scanForLeaks } from './index.ts';
import type { LeakScanResult, ProtectedAnswer } from './index.ts';

export function numeric(value: string, alternates?: readonly string[]): ProtectedAnswer {
  return alternates === undefined
    ? { kind: 'numeric', value }
    : { kind: 'numeric', value, alternates };
}

export function choice(value: string, alternates?: readonly string[]): ProtectedAnswer {
  return alternates === undefined
    ? { kind: 'multiple_choice', value }
    : { kind: 'multiple_choice', value, alternates };
}

export function spelling(value: string, alternates?: readonly string[]): ProtectedAnswer {
  return alternates === undefined
    ? { kind: 'spelling', value }
    : { kind: 'spelling', value, alternates };
}

export function text(value: string, alternates?: readonly string[]): ProtectedAnswer {
  return alternates === undefined ? { kind: 'text', value } : { kind: 'text', value, alternates };
}

export function scan(content: string, answer: ProtectedAnswer): LeakScanResult {
  return scanForLeaks(content, [answer]);
}

export function base64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

export function hex(value: string): string {
  return Buffer.from(value, 'utf8').toString('hex');
}

export function rot13(value: string): string {
  return value.replace(/[a-z]/gi, (c) => {
    const base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}
