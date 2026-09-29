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
/**
 * The abort branch of `send()`'s catch, on its own: everything from the `ScanCancelledError` test up to
 * the `ScanStoppedError` branch that follows it.
 */
const abortBranch =
  /if \(controller\.signal\.aborted \|\| error instanceof ScanCancelledError\) \{([\s\S]*?)\n {6}\} else if/.exec(
    scanScreen,
  )?.[1] ?? '';

describe('stopping a scan the server already took (HUNT4-MOB-5)', () => {
  it('branches on what the cancel answered instead of assuming it stopped', () => {
    // The operation moved into src/homework/upload.ts `runStoppedScan` (HUNT7-K-2), which is where the
    // cancel is issued, its answer turned into an outcome by `stoppedScanOutcome`, and the order the
    // child sees is RUN in a test rather than grepped out of this screen. What this screen must still
    // do is hand it the attempt it holds and act on what comes back.
    expect(abortBranch).toMatch(/await runStoppedScan\(childApi, attemptRef\.current,/);
    // The fresh attempt is conditional: keeping it is what makes "Try again" report the scan that is
    // already on its way rather than sending it a second time.
    expect(abortBranch).toMatch(
      /if \(!step\.outcome\.keepAttempt\) attemptRef\.current = newAttempt\(newKey\);/,
    );
    // And the screen never decides for itself that the scan stopped.
    expect(scanScreen).not.toMatch(/stoppedScanOutcome\(/);
  });

  it('[repro] does not report a cancel that never reached the server as a stop (HUNT5-H-4)', () => {
    // `.catch(() => 'cancelled' as const)` asserted success for a thrown cancel — offline, a timeout,
    // a 5xx — so the child was told the scan stopped and the keys were rotated, which let "Try again"
    // send the same homework a second time. cancelScan answers 'unsure' for those now, the outcome is
    // computed from that answer in upload.ts, and this screen prints whatever it is given.
    expect(scanScreen).not.toMatch(/catch\(\(\) => 'cancelled'/);
    expect(abortBranch).toMatch(/message: step\.outcome\.message/);
  });

  it('no longer hard-codes the "Stopped" message on the abort path', () => {
    // This used to search 400 characters from `ScanCancelledError) {` for the hard-coded message.
    // The branch is longer than that — its own comment runs past the bound, and this round made it
    // longer still — so the negative match covered no code at all and could not fail whatever the
    // screen did. It is bounded to the branch itself now: the two branches AFTER this one do use
    // childUploadMessage(error), legitimately, which is why the whole file cannot be searched.
    expect(abortBranch).not.toBe('');
    expect(abortBranch).toMatch(
      /setUpload\(\{ kind: 'error', message: step\.outcome\.message \}\);/,
    );
    expect(abortBranch).not.toMatch(/childUploadMessage/);
  });
});

/**
 * HUNT7-K-2. Between the child's "Stop sending" tap and the server's answer the screen kept claiming
 * "Sending page N of M…" with a live Stop button and no other control reachable: `abort()` sets no
 * state, and the abort branch left 'running' only once the cancel POST answered — up to twenty seconds
 * per attempt on a flaky connection, with the progress line already false. The ORDER is run in
 * src/homework/upload.test.ts (`runStoppedScan`); what is pinned here is the state the screen renders
 * for it, which this suite cannot render and so must read.
 */
describe('the child is answered the moment they stop a scan (HUNT7-K-2)', () => {
  /** The 'stopping' card on its own. */
  const stoppingCard =
    /\{upload\.kind === 'stopping' \? \(([\s\S]*?)\n {8}\) : null\}/.exec(scanScreen)?.[1] ?? '';

  it('[repro] the tap has a state of its own, set before the cancel answers', () => {
    expect(scanScreen).toMatch(/\| \{ kind: 'stopping' \}/);
    expect(abortBranch).toMatch(
      /if \(step\.kind === 'stopping'\) \{\s*setUpload\(\{ kind: 'stopping' \}\);\s*return;/,
    );
  });

  it('says only that it is stopping: no progress claim, and no button that can do nothing', () => {
    expect(stoppingCard).not.toBe('');
    expect(stoppingCard).toMatch(/\{CHILD_STOPPING_MESSAGE\}/);
    expect(stoppingCard).not.toMatch(/progressText|progressTrack|Stop sending/);
    // The progress card, the bar and the Stop button belong to 'running' alone.
    expect(scanScreen).toMatch(/\{upload\.kind === 'running' \? \([\s\S]*?label="Stop sending"/);
  });

  it('offers no second send, no new page and no reordering while a scan is stopping', () => {
    // `running` alone gated these, so 'stopping' would have put "Try again" back on screen with the
    // cancel still in flight — a second assignment, a second job and a second page charge for the same
    // homework (AC_CAPTURE_06).
    expect(scanScreen).toMatch(/const sending = running \|\| upload\.kind === 'stopping';/);
    expect(scanScreen).toMatch(/\{!sending && session\.pages\.length > 0 \? \(/);
    expect(scanScreen).toMatch(
      /\{!sending \? \(\s*<View style=\{styles\.row\}>\s*<Button\s+label="Take a photo"/,
    );
    expect(scanScreen).toMatch(
      /\{!sending \? \(\s*<View style=\{styles\.row\}>\s*<SmallButton\s+label="Up"/,
    );
  });
});

/**
 * HUNT6-J-7. `cancelScan` has had no throwing path since HUNT5-H-4: its one statement outside the try
 * cannot throw, and its catch answers 'unsure' instead of rethrowing (src/homework/upload.test.ts
 * proves it resolves against an api that rejects every call). The abort path was updated for that and
 * dropped its handler; the page-change caller kept a `.catch(() => undefined)` that can never run.
 * Dead error handling reads as live: a reader adding a third caller copies a handler that does nothing,
 * or takes the abort path's lack of one for an omission.
 */
describe('the page-change cancel has no handler for a rejection that cannot happen (HUNT6-J-7)', () => {
  /** `changePages` on its own, so the abort path's own call is not what is being read. */
  const changeBranch =
    /const changePages = useCallback\(([\s\S]*?)\n {2}\}, \[\]\);/.exec(scanScreen)?.[1] ?? '';

  it('[repro] neither caller pretends cancelScan can reject', () => {
    expect(changeBranch).not.toBe('');
    expect(changeBranch).toMatch(/void cancelScan\(childApi, previous\);/);
    // Nowhere in the screen, so the asymmetry the finding is about cannot come back on either side.
    expect(scanScreen).not.toMatch(/cancelScan\([^)]*\)\s*\.catch/);
  });

  it('says in one line that cancelScan answers rather than throws', () => {
    // The asymmetry with the abort path is deliberate — that one acts on the answer, this one cannot,
    // because the pages have changed and a new scan is the right outcome whatever the server did.
    expect(changeBranch).toMatch(/answers/i);
  });
});
