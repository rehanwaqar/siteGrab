import { initializeApp } from 'firebase/app';
import {
  createUserWithEmailAndPassword,
  getAuth,
  GithubAuthProvider,
  GoogleAuthProvider,
  OAuthProvider,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  type User,
} from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  getFirestore,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type FirestoreError,
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';
import type { CaptureMode, HistoryEntry, SavedPreviewBundle } from './types';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export const appleProvider = new OAuthProvider('apple.com');
appleProvider.addScope('email');
appleProvider.addScope('name');

export const githubProvider = new GithubAuthProvider();
githubProvider.addScope('user:email');

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null,
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection(): Promise<void> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
void testConnection();

export async function getAuthHeaders(forceRefresh = false): Promise<Record<string, string>> {
  const user = auth.currentUser;
  if (!user) return {};
  try {
    const token = await user.getIdToken(forceRefresh);
    return {
      Authorization: `Bearer ${token}`,
    };
  } catch {
    return {};
  }
}

export async function syncPreviewSessionCookie(): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;
  const token = await user.getIdToken();
  await fetch('/api/auth/preview-session', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  }).catch(() => {});
}

export async function signInWithGoogleAccount(): Promise<User> {
  const result = await signInWithPopup(auth, googleProvider);
  await syncPreviewSessionCookie();
  return result.user;
}

export async function signInWithAppleAccount(): Promise<User> {
  const result = await signInWithPopup(auth, appleProvider);
  await syncPreviewSessionCookie();
  return result.user;
}

export async function signInWithGithubAccount(): Promise<User> {
  const result = await signInWithPopup(auth, githubProvider);
  await syncPreviewSessionCookie();
  return result.user;
}

export async function signInWithEmailAccount(email: string, password: string): Promise<User> {
  const result = await signInWithEmailAndPassword(auth, email.trim(), password);
  if (result.user.emailVerified) {
    await syncPreviewSessionCookie();
  }
  return result.user;
}

export async function createEmailAccount(
  displayName: string,
  email: string,
  password: string,
): Promise<User> {
  const result = await createUserWithEmailAndPassword(auth, email.trim(), password);
  const cleanName = displayName.trim().slice(0, 120);
  if (cleanName) {
    await updateProfile(result.user, { displayName: cleanName });
  }
  await sendEmailVerification(result.user);
  return result.user;
}

export async function resendVerificationEmail(user: User): Promise<void> {
  await sendEmailVerification(user);
}

export async function sendAccountPasswordReset(email: string): Promise<void> {
  await sendPasswordResetEmail(auth, email.trim());
}

export async function signOutAccount(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  await signOut(auth);
}

export interface FriendlyAuthError {
  code: string;
  message: string;
  suggestSignUp?: boolean;
  suggestSignIn?: boolean;
}

export function formatFirebaseAuthError(
  err: unknown,
  attemptedProvider?: 'google' | 'apple' | 'github' | 'email',
): FriendlyAuthError {
  const code =
    err && typeof err === 'object' && 'code' in err ? String((err as { code?: string }).code) : '';

  switch (code) {
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return {
        code,
        message: 'Sign-in popup was closed before completing. Please try again.',
      };
    case 'auth/popup-blocked':
      return {
        code,
        message: 'Popups are blocked in this browser. Allow popups for this site and try again.',
      };
    case 'auth/user-not-found':
      return {
        code,
        message: 'No account exists for this email yet. Create a new account to continue.',
        suggestSignUp: true,
      };
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
      return {
        code,
        message:
          'Incorrect email or password, or no account exists with this email yet.',
        suggestSignUp: true,
      };
    case 'auth/email-already-in-use':
      return {
        code,
        message:
          'An account already exists with this email. Switch to Sign In or use Google, Apple, or GitHub.',
        suggestSignIn: true,
      };
    case 'auth/invalid-email':
      return {
        code,
        message: 'Please enter a valid email address.',
      };
    case 'auth/weak-password':
      return {
        code,
        message: 'Password is too weak. Please use at least 8 characters.',
      };
    case 'auth/account-exists-with-different-credential':
      return {
        code,
        message:
          'An account already exists with this email under another sign-in provider. Sign in with that method instead.',
      };
    case 'auth/operation-not-allowed':
      return {
        code,
        message:
          attemptedProvider === 'apple'
            ? 'Apple Sign-In is not enabled in Firebase Console yet. Enable Apple under Authentication > Sign-in method (with Apple Services ID & key) or sign in with Google.'
            : attemptedProvider === 'github'
              ? 'GitHub Sign-In is not enabled in Firebase Console yet. Enable GitHub under Authentication > Sign-in method (with your GitHub OAuth Client ID & Secret) or sign in with Google.'
              : attemptedProvider === 'email'
                ? 'Email/Password authentication is not enabled in Firebase Console yet. Enable Email/Password under Authentication > Sign-in method or continue with Google.'
                : 'This sign-in provider is not enabled in Firebase Console yet.',
      };
    case 'auth/too-many-requests':
      return {
        code,
        message: 'Too many authentication attempts. Please wait a moment and try again.',
      };
    default:
      return {
        code,
        message:
          err instanceof Error ? err.message : 'Unable to authenticate right now. Please try again.',
      };
  }
}

function sanitizeDocId(rawId: string): string {
  const cleaned = rawId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
  return cleaned || `snap_${Date.now()}`;
}

export async function upsertUserProfile(user: User, overrideDisplayName?: string): Promise<void> {
  if (!user.emailVerified) return;
  const userPath = `users/${user.uid}`;
  const userRef = doc(db, 'users', user.uid);
  const displayName =
    (overrideDisplayName || user.displayName || user.email?.split('@')[0] || 'SiteGrab User')
      .trim()
      .slice(0, 120) || 'SiteGrab User';
  const photoURL = user.photoURL ? user.photoURL.slice(0, 1024) : '';

  try {
    const existingSnap = await getDoc(userRef);
    if (!existingSnap.exists()) {
      const createPayload: Record<string, unknown> = {
        uid: user.uid,
        displayName,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      if (photoURL) {
        createPayload.photoURL = photoURL;
      }
      await setDoc(userRef, createPayload);
    } else {
      const updatePayload: Record<string, unknown> = {
        displayName,
        updatedAt: serverTimestamp(),
      };
      if (photoURL) {
        updatePayload.photoURL = photoURL;
      }
      await updateDoc(userRef, updatePayload);
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, userPath);
  }
}

export async function updateAccountDisplayName(user: User, newName: string): Promise<void> {
  const cleaned = newName.trim().slice(0, 120);
  if (!cleaned) {
    throw new Error('Display name cannot be empty.');
  }
  await updateProfile(user, { displayName: cleaned });
  await upsertUserProfile(user, cleaned);
}

export async function saveUserSnapshot(uid: string, entry: HistoryEntry): Promise<void> {
  const snapshotId = sanitizeDocId(entry.id);
  const docPath = `users/${uid}/snapshots/${snapshotId}`;
  const docRef = doc(db, 'users', uid, 'snapshots', snapshotId);

  const payload = {
    id: snapshotId,
    ownerUid: uid,
    url: (entry.url || 'https://example.com').slice(0, 2048),
    hostname: (entry.hostname || 'site').slice(0, 255),
    siteTitle: (entry.siteTitle || entry.hostname || 'Captured Site').slice(0, 300),
    zipFilename: (entry.zipFilename || 'sitegrab.zip').slice(0, 255),
    capturedAt: Math.max(0, Number(entry.capturedAt) || Date.now()),
    pagesCaptured: Math.max(0, Number(entry.stats.pagesCaptured) || 0),
    assetsCaptured: Math.max(0, Number(entry.stats.assetsCaptured) || 0),
    htmlCount: Math.max(0, Number(entry.stats.htmlCount) || 0),
    cssCount: Math.max(0, Number(entry.stats.cssCount) || 0),
    jsCount: Math.max(0, Number(entry.stats.jsCount) || 0),
    imagesCount: Math.max(0, Number(entry.stats.imagesCount) || 0),
    fontsCount: Math.max(0, Number(entry.stats.fontsCount) || 0),
    otherAssetsCount: Math.max(0, Number(entry.stats.otherAssetsCount) || 0),
    totalBytes: Math.max(0, Number(entry.stats.totalBytes) || 0),
    zipBytes: Math.max(0, Number(entry.stats.zipBytes ?? entry.stats.totalBytes) || 0),
    sourceMapsRecovered: Math.max(0, Number(entry.stats.sourceMapsRecovered) || 0),
    skippedRobots: Math.max(0, Number(entry.stats.skippedRobots) || 0),
    failedAssetsCount: Math.max(0, Number(entry.stats.failedAssetsCount) || 0),
    screenshotsCount: Math.max(0, Number(entry.stats.screenshotsCount) || 0),
    durationMs: Math.max(0, Number(entry.stats.durationMs) || 0),
    crawlDepth: Math.max(0, Number(entry.options.crawlDepth) || 0),
    maxPages: Math.max(1, Number(entry.options.maxPages) || 1),
    formatCode: Boolean(entry.options.formatCode),
    recoverSourceMaps: Boolean(entry.options.recoverSourceMaps),
    includeImages: Boolean(entry.options.includeImages),
    includeFonts: Boolean(entry.options.includeFonts),
    mobileViewport: Boolean(entry.options.mobileViewport),
    saveScreenshots: Boolean(entry.options.saveScreenshots),
    preserveInternalNav: Boolean(entry.options.preserveInternalNav),
    createdAt: serverTimestamp(),
  };

  try {
    await setDoc(docRef, payload);
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, docPath);
  }
}

export function subscribeToUserSnapshots(
  uid: string,
  onEntries: (entries: HistoryEntry[]) => void,
  onError?: (err: Error) => void,
): () => void {
  const snapshotsPath = `users/${uid}/snapshots`;
  const q = query(collection(db, 'users', uid, 'snapshots'), where('ownerUid', '==', uid));

  return onSnapshot(
    q,
    (snapshot) => {
      const entries: HistoryEntry[] = snapshot.docs.map((docSnap) => {
        const d = docSnap.data();
        return {
          id: String(d.id || docSnap.id),
          url: String(d.url || ''),
          hostname: String(d.hostname || ''),
          siteTitle: String(d.siteTitle || d.hostname || ''),
          zipFilename: String(d.zipFilename || 'sitegrab.zip'),
          capturedAt: Number(d.capturedAt || 0),
          stats: {
            pagesCaptured: Number(d.pagesCaptured || 0),
            assetsCaptured: Number(d.assetsCaptured || 0),
            htmlCount: Number(d.htmlCount || 0),
            cssCount: Number(d.cssCount || 0),
            jsCount: Number(d.jsCount || 0),
            imagesCount: Number(d.imagesCount || 0),
            fontsCount: Number(d.fontsCount || 0),
            otherAssetsCount: Number(d.otherAssetsCount || 0),
            totalBytes: Number(d.totalBytes || 0),
            zipBytes: Number(d.zipBytes || 0),
            sourceMapsRecovered: Number(d.sourceMapsRecovered || 0),
            skippedRobots: Number(d.skippedRobots || 0),
            failedAssetsCount: Number(d.failedAssetsCount || 0),
            screenshotsCount: Number(d.screenshotsCount || 0),
            durationMs: Number(d.durationMs || 0),
          },
          options: {
            crawlDepth: Number(d.crawlDepth || 0),
            maxPages: Number(d.maxPages || 1),
            formatCode: Boolean(d.formatCode),
            recoverSourceMaps: Boolean(d.recoverSourceMaps),
            includeImages: Boolean(d.includeImages),
            includeFonts: Boolean(d.includeFonts),
            mobileViewport: Boolean(d.mobileViewport),
            saveScreenshots: Boolean(d.saveScreenshots),
            preserveInternalNav: Boolean(d.preserveInternalNav),
          },
        };
      });
      entries.sort((a, b) => b.capturedAt - a.capturedAt);
      onEntries(entries.slice(0, 25));
    },
    (fsErr: FirestoreError) => {
      try {
        handleFirestoreError(fsErr, OperationType.LIST, snapshotsPath);
      } catch (wrapped) {
        onError?.(wrapped instanceof Error ? wrapped : new Error(String(wrapped)));
      }
    },
  );
}

export async function saveUserSnapshotBundle(
  uid: string,
  snapshotIdRaw: string,
  bundle: SavedPreviewBundle,
): Promise<void> {
  const snapshotId = sanitizeDocId(snapshotIdRaw);
  const bundlePath = `users/${uid}/snapshots/${snapshotId}/bundles/preview`;
  const bundleRef = doc(db, 'users', uid, 'snapshots', snapshotId, 'bundles', 'preview');

  const textEncoder = new TextEncoder();
  const sanitizedFiles: Array<{ path: string; content: string }> = [];
  let totalBytes = 0;

  for (const item of bundle.files || []) {
    if (sanitizedFiles.length >= 40) break;
    if (!item || typeof item.path !== 'string' || typeof item.content !== 'string') continue;
    const cleanPath = item.path.trim().slice(0, 300);
    if (!cleanPath) continue;
    const byteSize = textEncoder.encode(item.content).length;
    if (byteSize > 450_000 || totalBytes + byteSize > 650_000) continue;
    sanitizedFiles.push({ path: cleanPath, content: item.content });
    totalBytes += byteSize;
  }

  if (sanitizedFiles.length === 0) return;

  const captureMode: CaptureMode =
    bundle.captureMode === 'clone' ||
    bundle.captureMode === 'zip' ||
    bundle.captureMode === 'screenshot'
      ? bundle.captureMode
      : 'live';

  let existingSnap;
  try {
    existingSnap = await getDoc(bundleRef);
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, bundlePath);
  }

  if (!existingSnap.exists()) {
    try {
      await setDoc(bundleRef, {
        snapshotId,
        ownerUid: uid,
        captureMode,
        totalBytes,
        files: sanitizedFiles,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, bundlePath);
    }
  } else {
    try {
      await updateDoc(bundleRef, {
        captureMode,
        totalBytes,
        files: sanitizedFiles,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, bundlePath);
    }
  }
}

export async function getUserSnapshotBundle(
  uid: string,
  snapshotIdRaw: string,
): Promise<SavedPreviewBundle | null> {
  const snapshotId = sanitizeDocId(snapshotIdRaw);
  const bundlePath = `users/${uid}/snapshots/${snapshotId}/bundles/preview`;
  const bundleRef = doc(db, 'users', uid, 'snapshots', snapshotId, 'bundles', 'preview');

  try {
    const snap = await getDoc(bundleRef);
    if (!snap.exists()) return null;
    const d = snap.data();
    const rawFiles = Array.isArray(d.files) ? d.files : [];
    const files = rawFiles
      .filter(
        (f): f is { path: string; content: string } =>
          Boolean(f) && typeof f.path === 'string' && typeof f.content === 'string',
      )
      .map((f) => ({ path: f.path, content: f.content }));

    if (files.length === 0) return null;

    const captureMode: CaptureMode =
      d.captureMode === 'clone' || d.captureMode === 'zip' || d.captureMode === 'screenshot'
        ? d.captureMode
        : 'live';

    return {
      captureMode,
      totalBytes: Number(d.totalBytes || 0),
      files,
    };
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, bundlePath);
  }
}

export async function clearUserSnapshots(uid: string): Promise<void> {
  const snapshotsPath = `users/${uid}/snapshots`;
  try {
    const q = query(collection(db, 'users', uid, 'snapshots'), where('ownerUid', '==', uid));
    const snap = await getDocs(q);
    if (snap.empty) return;
    const batch = writeBatch(db);
    snap.docs.forEach((docSnap) => {
      batch.delete(doc(db, 'users', uid, 'snapshots', docSnap.id, 'bundles', 'preview'));
      batch.delete(docSnap.ref);
    });
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, snapshotsPath);
  }
}
