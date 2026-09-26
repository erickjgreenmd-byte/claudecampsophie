import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The child scan screen imports react-native, which this pure-logic suite cannot render (see
 * vitest.config.ts), so these checks read its source. They guard AC_CAPTURE_01 / AC_UX_02 "real
 * connected behavior": a PDF import would always end failed_final FORMAT_NEEDS_CONVERSION until the
 * isolated converter ships, so the screen must not offer one. Photo capture and picking stay (photos
 * are re-encoded to JPEG on the device).
 */
const scanScreen = readFileSync(
  join(import.meta.dirname, '..', '..', 'app', '(child)', 'scan.tsx'),
  'utf8',
);

describe('child scan screen offers only what the scan job can read (AC_CAPTURE_01, AC_UX_02)', () => {
  it('has no PDF import: no document picker and no “Add a PDF” button', () => {
    expect(scanScreen).not.toMatch(/expo-document-picker|DocumentPicker|getDocumentAsync/);
    expect(scanScreen).not.toMatch(/Add a PDF/i);
    expect(scanScreen).not.toMatch(/application\/pdf/);
  });

  it('keeps camera capture and photo picking, re-encoding photos to JPEG on the device', () => {
    expect(scanScreen).toMatch(/label="Take a photo"/);
    expect(scanScreen).toMatch(/label="Choose photos"/);
    expect(scanScreen).toMatch(/normalizePhoto\(asset\.uri\)/);
  });

  it('shows the limits summary, which says PDF files can’t be added yet, before anything is sent', () => {
    expect(scanScreen).toMatch(/\{limitsSummary\(limits\)\}/);
  });
});

describe('the camera and the hardware Back button (MOB-R1-07)', () => {
  it('Back while the camera is open closes only the camera; the pages already added stay', () => {
    expect(scanScreen).toMatch(
      /BackHandler\.addEventListener\('hardwareBackPress', \(\) => \{\s*setCameraOpen\(false\);\s*return true;/,
    );
    expect(scanScreen).toMatch(/\}, \[cameraOpen\]\);/);
  });

  it('the scan screen carries the child nav (a way home without the native header)', () => {
    expect(scanScreen).toMatch(/<ChildNav \/>/);
  });
});

/**
 * HUNT4-MOB-5. The abort path used to ignore what cancelScan answered: it always told the child
 * "Stopped." and rotated the idempotency keys, so a scan the server had already taken was reported
 * as stopped and "Try again" created a second assignment for the same homework (two jobs, two page
 * charges against AC_CAPTURE_06). The screen must branch on the answer; the decision itself lives in
 * src/homework/upload.ts `stoppedScanOutcome` and is unit-tested there.
 */
describe('stopping a scan the server already took (HUNT4-MOB-5)', () => {
  /**
   * The abort branch of `send()`'s catch, on its own: everything from the `ScanCancelledError` test
   * up to the `ScanStoppedError` branch that follows it.
   */
  const abortBranch =
    /if \(controller\.signal\.aborted \|\| error instanceof ScanCancelledError\) \{([\s\S]*?)\n {6}\} else if/.exec(
      scanScreen,
    )?.[1] ?? '';

  it('branches on what the cancel answered instead of assuming it stopped', () => {
    expect(scanScreen).toMatch(/stoppedScanOutcome\(/);
    expect(scanScreen).toMatch(/await cancelScan\(childApi, attemptRef\.current\)/);
    // The fresh attempt is conditional now: keeping it is what makes "Try again" report the scan
    // that is already on its way rather than sending it a second time.
    expect(scanScreen).toMatch(
      /if \(!outcome\.keepAttempt\) attemptRef\.current = newAttempt\(newKey\);/,
    );
  });

  it('[repro] does not report a cancel that never reached the server as a stop (HUNT5-H-4)', () => {
    // `.catch(() => 'cancelled' as const)` asserted success for a thrown cancel — offline, a timeout,
    // a 5xx — so the child was told the scan stopped and the keys were rotated, which let "Try again"
    // send the same homework a second time. cancelScan answers 'unsure' for those now, and the screen
    // branches on it like the rest.
    expect(scanScreen).not.toMatch(/catch\(\(\) => 'cancelled'/);
    expect(scanScreen).toMatch(
      /stoppedScanOutcome\(await cancelScan\(childApi, attemptRef\.current\)\);/,
    );
  });

  it('no longer hard-codes the "Stopped" message on the abort path', () => {
    // This used to search 400 characters from `ScanCancelledError) {` for the hard-coded message.
    // The branch is longer than that — its own comment runs past the bound, and this round made it
    // longer still — so the negative match covered no code at all and could not fail whatever the
    // screen did. It is bounded to the branch itself now: the two branches AFTER this one do use
    // childUploadMessage(error), legitimately, which is why the whole file cannot be searched.
    expect(abortBranch).not.toBe('');
    expect(abortBranch).toMatch(/setUpload\(\{ kind: 'error', message: outcome\.message \}\);/);
    expect(abortBranch).not.toMatch(/childUploadMessage/);
  });
});
