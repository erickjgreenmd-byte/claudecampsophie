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
