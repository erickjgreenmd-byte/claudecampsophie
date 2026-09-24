import type { AppMode } from './mode.ts';

/**
 * Where the welcome screen sends the user. A paired child device always opens the child space; the
 * parent area needs a signed-in parent and then a fresh PIN unlock (never a remembered one).
 */
export function entryRoute(
  mode: AppMode,
  childPaired: boolean,
  parentSignedIn: boolean,
  choice: 'parent' | 'child' | null,
): string | null {
  if (choice === null) return mode === 'child' && childPaired ? '/(child)/home' : null;
  if (choice === 'child') return childPaired ? '/(child)/home' : '/pair';
  return parentSignedIn ? '/(parent)/unlock' : '/(parent)/sign-in';
}
