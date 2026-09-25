import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '../../app.config.ts';

/**
 * Every icon, splash and favicon path that app.config.ts names must exist and be a PNG of the size
 * the platform expects (brand/ASSETS.md). Dimensions come from the PNG header (IHDR), so a renamed,
 * truncated or resampled export fails here before a store build does.
 */

const mobileRoot = join(import.meta.dirname, '..', '..');
const PNG_SIGNATURE = '89504e470d0a1a0a';

function pngSize(relativePath: string): { width: number; height: number } {
  expect(relativePath, 'config paths are relative to apps/mobile').toMatch(/^\.\/assets\/brand\//);
  const bytes = readFileSync(join(mobileRoot, relativePath));
  expect(bytes.subarray(0, 8).toString('hex'), `${relativePath} is a PNG`).toBe(PNG_SIGNATURE);
  expect(bytes.subarray(12, 16).toString('latin1'), `${relativePath} starts with IHDR`).toBe(
    'IHDR',
  );
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function splashProps(): Record<string, unknown> {
  const entry = config.plugins?.find(
    (plugin): plugin is [string, Record<string, unknown>] =>
      Array.isArray(plugin) && plugin[0] === 'expo-splash-screen',
  );
  expect(entry, 'expo-splash-screen plugin entry with props').toBeDefined();
  return entry?.[1] ?? {};
}

describe('app.config.ts brand assets', () => {
  it('names the iOS icon (opaque 1024 px square; the platforms mask the corners)', () => {
    expect(config.icon).toBe('./assets/brand/icon-ios-1024.png');
    expect(pngSize(config.icon ?? '')).toEqual({ width: 1024, height: 1024 });
    expect(config.ios?.supportsTablet).toBe(true);
  });

  it('names the Android adaptive icon layers over the teal ground', () => {
    const adaptive = config.android?.adaptiveIcon;
    expect(adaptive).toEqual({
      foregroundImage: './assets/brand/adaptive-foreground-1024.png',
      monochromeImage: './assets/brand/adaptive-monochrome-1024.png',
      backgroundColor: '#008D87',
    });
    expect(pngSize(adaptive?.foregroundImage ?? '')).toEqual({ width: 1024, height: 1024 });
    expect(pngSize(adaptive?.monochromeImage ?? '')).toEqual({ width: 1024, height: 1024 });
  });

  it('configures expo-splash-screen with the splash art on the off-white ground', () => {
    const props = splashProps();
    expect(props).toMatchObject({
      image: './assets/brand/splash-1200.png',
      imageWidth: 220,
      resizeMode: 'contain',
      backgroundColor: '#F7F9FB',
    });
    expect(pngSize(String(props.image))).toEqual({ width: 1200, height: 1200 });
  });

  it('keeps the light interface style coherent: no dark splash while the UI has no dark theme', () => {
    // expo-splash-screen's iOS plugin writes UIUserInterfaceStyle=Automatic whenever a dark splash
    // is configured, overriding `userInterfaceStyle: 'light'` (it warns about exactly this). The
    // dark splash art stays exported (brand/ASSETS.md) for when the app switches to 'automatic'.
    expect(config.userInterfaceStyle).toBe('light');
    expect(config.ios?.userInterfaceStyle).toBeUndefined();
    const props = splashProps();
    expect(props.dark).toBeUndefined();
    expect(props.ios).toBeUndefined();
    expect(props.android).toBeUndefined();
    expect(pngSize('./assets/brand/splash-dark-1200.png')).toEqual({ width: 1200, height: 1200 });
  });

  it('names the web favicon (the transparent symbol)', () => {
    expect(config.web?.favicon).toBe('./assets/brand/symbol-256.png');
    expect(pngSize(config.web?.favicon ?? '')).toEqual({ width: 256, height: 256 });
  });

  it('keeps the in-app mark sources the BrandMark component imports', () => {
    expect(pngSize('./assets/brand/symbol-256.png')).toEqual({ width: 256, height: 256 });
    expect(pngSize('./assets/brand/symbol-512.png')).toEqual({ width: 512, height: 512 });
  });
});
