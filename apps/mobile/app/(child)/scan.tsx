import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { randomUUID } from 'expo-crypto';
import * as ImagePicker from 'expo-image-picker';
import { openSettings } from 'expo-linking';
import { router } from 'expo-router';
import {
  DEFAULT_HOMEWORK_UPLOAD_LIMITS,
  uploadLimitsResponseSchema,
  type HomeworkUploadLimits,
} from '@pencillift/contracts';
import { colors, minTouchTarget, radii, spacing, typography } from '@pencillift/ui-tokens';
import { BrandRow } from '../../src/brand/BrandMark.tsx';
import { ChildNav, GatedButton } from '../../src/family/ui.tsx';
import { childApi } from '../../src/homework/child-api.ts';
import { nativeUploadIo, normalizePhoto } from '../../src/homework/native-io.ts';
import {
  EMPTY_SESSION,
  addPages,
  canSend,
  describeSize,
  isOversizedPicture,
  limitsSummary,
  movePage,
  problemCopy,
  remainingSlots,
  removePage,
  replacePage,
  toScanPage,
  validateSession,
  type PageSource,
  type PickedAsset,
  type ScanSession,
} from '../../src/homework/scan-session.ts';
import {
  ScanCancelledError,
  ScanStoppedError,
  cancelScan,
  childUploadMessage,
  newAttempt,
  uploadScan,
  type UploadAttempt,
  type UploadProgress,
} from '../../src/homework/upload.ts';

/**
 * Child scan screen (spec P5, P14 child "scan"; AC_CAPTURE_01/02, AC_UX_02). Camera and photo
 * library, with a permission-denied fallback for each; page list with reorder, turn and remove;
 * limits shown before anything is sent; upload progress with a working stop button. Child-facing
 * copy is calm and never commercial.
 *
 * PDF import is not offered yet: the scan job cannot read PDFs until the isolated converter ships
 * (such a scan would always end failed_final FORMAT_NEEDS_CONVERSION), and the limits card says so.
 * Photos are re-encoded to JPEG on the device, which also turns HEIC photos into readable JPEGs.
 */

type UploadState =
  | { kind: 'idle' }
  | { kind: 'running'; progress: UploadProgress }
  | { kind: 'error'; message: string }
  | { kind: 'done'; assignmentId: string };

type PermissionHelp = 'camera' | 'library' | null;

const newKey = () => randomUUID();

function progressText(p: UploadProgress): string {
  switch (p.phase) {
    case 'preparing':
      return `Getting your pages ready… (${Math.min(p.pagesDone + 1, p.pagesTotal)} of ${p.pagesTotal})`;
    case 'uploading':
      return `Sending page ${Math.min(p.pagesDone + 1, p.pagesTotal)} of ${p.pagesTotal}…`;
    case 'sending':
      return 'Almost done…';
    case 'done':
      return 'Sent!';
  }
}

export default function ScanScreen() {
  const [limits, setLimits] = useState<HomeworkUploadLimits>(DEFAULT_HOMEWORK_UPLOAD_LIMITS);
  const [session, setSession] = useState<ScanSession>(EMPTY_SESSION);
  const [notice, setNotice] = useState<string | null>(null);
  const [permissionHelp, setPermissionHelp] = useState<PermissionHelp>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [upload, setUpload] = useState<UploadState>({ kind: 'idle' });
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const attemptRef = useRef<UploadAttempt>(newAttempt(newKey));
  const controllerRef = useRef<AbortController | null>(null);

  // The server's configured limits; the shipped defaults show until (or unless) they load. The
  // server enforces the same limits either way.
  useEffect(() => {
    let active = true;
    childApi.get('/v1/assignments/limits', uploadLimitsResponseSchema).then(
      (body) => {
        if (active) setLimits(body.limits);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, []);

  const running = upload.kind === 'running';

  // Android/Fire hardware Back while the camera is open closes only the camera (MOB-R1-07); the
  // pages already added stay. On iOS this listener is a no-op.
  useEffect(() => {
    if (!cameraOpen) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setCameraOpen(false);
      return true;
    });
    return () => subscription.remove();
  }, [cameraOpen]);

  /** Any change to the pages starts a fresh scan; an earlier unfinished one is stopped. */
  const changePages = useCallback((next: ScanSession) => {
    const previous = attemptRef.current;
    if (previous.assignmentId !== null) void cancelScan(childApi, previous).catch(() => undefined);
    attemptRef.current = newAttempt(newKey);
    setUpload({ kind: 'idle' });
    setSession(next);
  }, []);

  const add = useCallback(
    async (assets: PickedAsset[], source: PageSource) => {
      const prepared: PickedAsset[] = [];
      for (const asset of assets) {
        // A picture over the size limits (AC_CAPTURE_02) is added as is, without a second decode
        // here: its page shows the problem and the scan cannot be sent.
        if (isOversizedPicture(asset)) {
          prepared.push(asset);
          continue;
        }
        try {
          // Re-encode photos on the device: drops location/EXIF metadata (spec P4). Re-encoding
          // keeps the pixel size (a turn only swaps the sides), so the picker's size still applies.
          prepared.push({
            uri: await normalizePhoto(asset.uri),
            mimeType: 'image/jpeg',
            width: asset.width ?? null,
            height: asset.height ?? null,
          });
        } catch {
          prepared.push(asset);
        }
      }
      const pages = prepared.map((a) => toScanPage(a, source, newKey));
      const result = addPages(session, pages, limits);
      changePages(result.session);
      setNotice(
        result.dropped > 0
          ? `Only ${limits.maxPages} pages fit in one scan, so ${result.dropped} ${result.dropped === 1 ? 'page was' : 'pages were'} left out.`
          : null,
      );
    },
    [session, limits, changePages],
  );

  const openCamera = async () => {
    setPermissionHelp(null);
    const status = cameraPermission?.granted ? cameraPermission : await requestCameraPermission();
    if (!status.granted) {
      setPermissionHelp('camera');
      return;
    }
    setCameraOpen(true);
  };

  const takePhoto = async () => {
    setBusy(true);
    try {
      const picture = await cameraRef.current?.takePictureAsync({ quality: 0.85, exif: false });
      if (picture) {
        await add(
          [
            {
              uri: picture.uri,
              mimeType: 'image/jpeg',
              width: picture.width,
              height: picture.height,
            },
          ],
          'camera',
        );
      }
    } catch {
      setNotice('The camera didn’t take that photo. Let’s try again.');
    } finally {
      setBusy(false);
      setCameraOpen(false);
    }
  };

  const choosePhotos = async () => {
    setPermissionHelp(null);
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setPermissionHelp('library');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      orderedSelection: true,
      selectionLimit: Math.max(1, remainingSlots(session, limits)),
      quality: 0.85,
      exif: false,
    });
    if (result.canceled) return;
    setBusy(true);
    try {
      await add(
        result.assets.map((a) => ({
          uri: a.uri,
          mimeType: a.mimeType ?? null,
          fileName: a.fileName ?? null,
          fileSize: a.fileSize ?? null,
          width: a.width,
          height: a.height,
        })),
        'library',
      );
    } finally {
      setBusy(false);
    }
  };

  const turnPage = async (localId: string, uri: string) => {
    setBusy(true);
    try {
      changePages(
        replacePage(session, localId, { uri: await normalizePhoto(uri, 90), byteSize: null }),
      );
    } catch {
      setNotice('That page couldn’t be turned. You can take it again instead.');
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    const controller = new AbortController();
    controllerRef.current = controller;
    setNotice(null);
    setUpload({
      kind: 'running',
      progress: { phase: 'preparing', pagesDone: 0, pagesTotal: session.pages.length },
    });
    try {
      const result = await uploadScan({
        api: childApi,
        io: nativeUploadIo,
        pages: session.pages,
        limits,
        attempt: attemptRef.current,
        signal: controller.signal,
        onProgress: (progress) => setUpload({ kind: 'running', progress }),
        onAttempt: (attempt) => {
          attemptRef.current = attempt;
        },
      });
      attemptRef.current = result.attempt;
      setUpload({ kind: 'done', assignmentId: result.assignment.id });
    } catch (error) {
      if (controller.signal.aborted || error instanceof ScanCancelledError) {
        // Stop means stop: the server releases anything reserved for this scan.
        await cancelScan(childApi, attemptRef.current).catch(() => undefined);
        attemptRef.current = newAttempt(newKey);
        setUpload({ kind: 'error', message: childUploadMessage(new ScanCancelledError()) });
      } else if (error instanceof ScanStoppedError) {
        // The server scan was stopped (e.g. by a grown-up): "Try again" sends a new scan.
        attemptRef.current = newAttempt(newKey);
        setUpload({ kind: 'error', message: childUploadMessage(error) });
      } else {
        // Keep the same attempt: "Try again" resumes and skips pages already sent, or reports a
        // scan whose finalize already worked as sent.
        setUpload({ kind: 'error', message: childUploadMessage(error) });
      }
    } finally {
      controllerRef.current = null;
    }
  };

  const startOver = () => {
    attemptRef.current = newAttempt(newKey);
    setSession(EMPTY_SESSION);
    setUpload({ kind: 'idle' });
    setNotice(null);
  };

  const problems = validateSession(session, limits);
  const pageProblems = new Map(
    problems.flatMap((p) =>
      p.kind === 'page' ? [[p.localId, problemCopy(p, limits)] as const] : [],
    ),
  );
  const sessionProblems = problems.filter((p) => p.kind === 'too_many_pages');

  if (cameraOpen) {
    return (
      <SafeAreaView style={styles.cameraScreen}>
        <CameraView ref={cameraRef} style={styles.camera} facing="back" />
        <View style={styles.row}>
          <Button label="Take photo" onPress={() => void takePhoto()} disabled={busy} />
          <Button
            label="Close camera"
            secondary
            onPress={() => setCameraOpen(false)}
            disabled={busy}
          />
        </View>
      </SafeAreaView>
    );
  }

  if (upload.kind === 'done') {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.content}>
          <BrandRow />
          <ChildNav />
        </View>
        <View style={styles.center}>
          <Text style={styles.title} accessibilityRole="header">
            Sent!
          </Text>
          <Text style={styles.body}>
            We’re checking your work. Come back soon to see how you did.
          </Text>
          <Button
            label="See my scans"
            onPress={() =>
              router.push({ pathname: '/results', params: { id: upload.assignmentId } })
            }
          />
          <Button label="Scan more homework" secondary onPress={startOver} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <BrandRow />
        <ChildNav />
        <Text style={styles.title} accessibilityRole="header">
          Scan your homework
        </Text>
        <View
          style={styles.card}
          accessible
          accessibilityLabel={`Before you start. ${limitsSummary(limits)}`}
        >
          <Text style={styles.cardTitle}>Before you start</Text>
          <Text style={styles.body}>{limitsSummary(limits)}</Text>
          <Text style={styles.body}>Lay the page flat in good light so every word shows.</Text>
        </View>

        {!running ? (
          <View style={styles.row}>
            <Button
              label="Take a photo"
              onPress={() => void openCamera()}
              disabled={busy || remainingSlots(session, limits) === 0}
            />
            <Button
              label="Choose photos"
              secondary
              onPress={() => void choosePhotos()}
              disabled={busy || remainingSlots(session, limits) === 0}
            />
          </View>
        ) : null}

        {permissionHelp ? (
          <View style={styles.notice} accessibilityRole="alert">
            <Text style={styles.body}>
              {permissionHelp === 'camera'
                ? 'The camera is turned off for PencilLift. You can choose a photo you already took, or ask a grown-up to turn the camera on in Settings.'
                : 'PencilLift can’t see your photos. You can take a photo instead, or ask a grown-up to allow photos in Settings.'}
            </Text>
            <View style={styles.row}>
              <Button
                label={
                  permissionHelp === 'camera' ? 'Choose photos instead' : 'Take a photo instead'
                }
                onPress={() => void (permissionHelp === 'camera' ? choosePhotos() : openCamera())}
              />
            </View>
            {/* Leaving the app for Settings is a grown-up's step: it sits behind the parental gate
                (APL-02 / PLAY-07). */}
            <GatedButton
              label="Grown-ups: open Settings"
              purpose="open the device Settings"
              secondary
              onPassed={() => void openSettings()}
            />
          </View>
        ) : null}

        {notice ? (
          <Text style={styles.noticeText} accessibilityRole="alert">
            {notice}
          </Text>
        ) : null}

        {session.pages.length === 0 ? (
          <Text style={styles.body}>No pages yet. Add your first page above.</Text>
        ) : (
          <View accessibilityLabel="Your pages">
            {session.pages.map((page, index) => {
              const n = index + 1;
              const problem = pageProblems.get(page.localId);
              return (
                <View key={page.localId} style={styles.page}>
                  <Image
                    source={{ uri: page.uri }}
                    style={styles.thumb}
                    accessibilityLabel={`Photo of page ${n}`}
                  />
                  <View style={styles.pageInfo}>
                    <Text style={styles.cardTitle}>Page {n}</Text>
                    {page.byteSize !== null ? (
                      <Text style={styles.small}>{describeSize(page.byteSize)}</Text>
                    ) : null}
                    {problem ? (
                      <Text style={styles.problem} accessibilityRole="alert">
                        ⚠ {problem}
                      </Text>
                    ) : null}
                    {!running ? (
                      <View style={styles.row}>
                        <SmallButton
                          label="Up"
                          a11y={`Move page ${n} up`}
                          disabled={index === 0}
                          onPress={() => changePages(movePage(session, page.localId, -1))}
                        />
                        <SmallButton
                          label="Down"
                          a11y={`Move page ${n} down`}
                          disabled={index === session.pages.length - 1}
                          onPress={() => changePages(movePage(session, page.localId, 1))}
                        />
                        <SmallButton
                          label="Turn"
                          a11y={`Turn page ${n}`}
                          disabled={busy}
                          onPress={() => void turnPage(page.localId, page.uri)}
                        />
                        <SmallButton
                          label="Remove"
                          a11y={`Remove page ${n}`}
                          onPress={() => changePages(removePage(session, page.localId))}
                        />
                      </View>
                    ) : null}
                  </View>
                </View>
              );
            })}
          </View>
        )}

        {sessionProblems.map((p) => (
          <Text key={p.kind} style={styles.problem} accessibilityRole="alert">
            ⚠ {problemCopy(p, limits)}
          </Text>
        ))}

        {upload.kind === 'running' ? (
          <View style={styles.card}>
            <Text style={styles.body}>{progressText(upload.progress)}</Text>
            <View
              style={styles.progressTrack}
              accessibilityRole="progressbar"
              accessibilityLabel="Sending your pages"
              accessibilityValue={{
                min: 0,
                max: upload.progress.pagesTotal,
                now: upload.progress.pagesDone,
              }}
            >
              <View
                style={[
                  styles.progressFill,
                  {
                    width: `${Math.round((upload.progress.pagesDone / Math.max(1, upload.progress.pagesTotal)) * 100)}%`,
                  },
                ]}
              />
            </View>
            <Button label="Stop sending" secondary onPress={() => controllerRef.current?.abort()} />
          </View>
        ) : null}

        {upload.kind === 'error' ? (
          <Text style={styles.noticeText} accessibilityRole="alert">
            {upload.message}
          </Text>
        ) : null}

        {!running && session.pages.length > 0 ? (
          <Button
            label={upload.kind === 'error' ? 'Try again' : 'Send my homework'}
            onPress={() => void send()}
            disabled={busy || !canSend(session, limits)}
          />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Button({
  label,
  onPress,
  disabled = false,
  secondary = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        secondary ? styles.buttonSecondary : null,
        disabled ? styles.disabled : null,
      ]}
    >
      <Text style={[styles.buttonText, secondary ? { color: colors.tealText } : null]}>
        {label}
      </Text>
    </Pressable>
  );
}

function SmallButton({
  label,
  a11y,
  onPress,
  disabled = false,
}: {
  label: string;
  a11y: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.smallButton, disabled ? styles.disabled : null]}
    >
      <Text style={styles.smallButtonText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.offWhite },
  cameraScreen: { flex: 1, backgroundColor: colors.navy },
  camera: { flex: 1 },
  content: {
    padding: spacing.md,
    gap: spacing.md,
    width: '100%',
    maxWidth: 640 + 2 * spacing.md,
    alignSelf: 'center',
  },
  center: { flex: 1, padding: spacing.lg, justifyContent: 'center', gap: spacing.md },
  title: { fontSize: typography.scale.xl, fontWeight: '800', color: colors.navy },
  body: { fontSize: typography.scale.md, color: colors.navy },
  small: { fontSize: typography.scale.sm, color: colors.muted },
  card: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  cardTitle: { fontSize: typography.scale.md, fontWeight: '800', color: colors.navy },
  notice: {
    backgroundColor: '#FFF8EB',
    borderLeftWidth: 4,
    borderLeftColor: colors.gold,
    padding: spacing.md,
    borderRadius: radii.sm,
    gap: spacing.sm,
  },
  noticeText: {
    fontSize: typography.scale.md,
    color: colors.navy,
    backgroundColor: '#FFF8EB',
    padding: spacing.md,
    borderRadius: radii.sm,
  },
  problem: { fontSize: typography.scale.sm, color: colors.danger, fontWeight: '700' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, alignItems: 'center' },
  page: {
    flexDirection: 'row',
    gap: spacing.md,
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.sm,
    marginBottom: spacing.sm,
  },
  thumb: { width: 72, height: 96, borderRadius: radii.sm, backgroundColor: colors.offWhite },
  pageInfo: { flex: 1, gap: spacing.xs },
  button: {
    minHeight: minTouchTarget,
    borderRadius: radii.pill,
    backgroundColor: colors.tealText,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    marginVertical: spacing.xs,
  },
  buttonSecondary: { backgroundColor: colors.white, borderWidth: 2, borderColor: colors.teal },
  buttonText: { color: colors.white, fontSize: typography.scale.md, fontWeight: '800' },
  smallButton: {
    minHeight: minTouchTarget,
    minWidth: minTouchTarget,
    borderRadius: radii.pill,
    borderWidth: 2,
    borderColor: colors.teal,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  smallButtonText: { color: colors.tealText, fontWeight: '800', fontSize: typography.scale.sm },
  disabled: { opacity: 0.5 },
  progressTrack: {
    height: 12,
    borderRadius: radii.pill,
    backgroundColor: colors.offWhite,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.muted,
  },
  progressFill: { height: '100%', backgroundColor: colors.teal },
});
