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
  it('branches on what the cancel answered instead of assuming it stopped', () => {
    expect(scanScreen).toMatch(/stoppedScanOutcome\(/);
    expect(scanScreen).toMatch(/await cancelScan\(childApi, attemptRef\.current\)/);
    // The fresh attempt is conditional now: keeping it is what makes "Try again" report the scan
    // that is already on its way rather than sending it a second time.
    expect(scanScreen).toMatch(
      /if \(!outcome\.keepAttempt\) attemptRef\.current = newAttempt\(newKey\);/,
    );
  });

  it('no longer hard-codes the "Stopped" message on the abort path', () => {
    expect(scanScreen).not.toMatch(
      /ScanCancelledError\) \{[\s\S]{0,400}?setUpload\(\{ kind: 'error', message: childUploadMessage\(new ScanCancelledError\(\)\) \}\)/,
    );
  });
});
