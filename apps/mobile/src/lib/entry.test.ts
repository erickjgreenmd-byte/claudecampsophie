import { describe, expect, it } from 'vitest';
import { entryRoute } from './entry.ts';

describe('welcome screen routing', () => {
  it('a paired device in child mode opens the child space directly', () => {
    expect(entryRoute('child', true, true, null)).toBe('/(child)/home');
    expect(entryRoute('signed_out', false, false, null)).toBeNull();
  });

  it('the parent area always goes through sign-in and a fresh PIN unlock', () => {
    expect(entryRoute('child', true, false, 'parent')).toBe('/(parent)/sign-in');
    expect(entryRoute('child', true, true, 'parent')).toBe('/(parent)/unlock');
    expect(entryRoute('parent', false, true, 'parent')).toBe('/(parent)/unlock');
  });

  it('connecting a child pairs first', () => {
    expect(entryRoute('signed_out', false, true, 'child')).toBe('/pair');
    expect(entryRoute('signed_out', true, false, 'child')).toBe('/(child)/home');
  });
});
