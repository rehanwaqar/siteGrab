import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { onAuthStateChanged, type User } from 'firebase/auth';
import {
  AlertTriangle,
  BookOpen,
  Download,
  ExternalLink,
  FileArchive,
  Github,
  Globe,
  Image as ImageIcon,
  Linkedin,
  Loader2,
  LogOut,
  MessageSquarePlus,
  Moon,
  RotateCcw,
  SlidersHorizontal,
  Sun,
  Upload,
} from 'lucide-react';
import { AccountModal } from './components/AccountModal';
import { AuthGate } from './components/AuthGate';
import { FailureRecoveryPanel, type RecoveryRetrySettings } from './components/FailureRecoveryPanel';
import { FeedbackView } from './components/FeedbackView';
import { GuideView } from './components/GuideView';
import { HistoryView, type HistoryPreviewWorkspace } from './components/HistoryView';
import { PreviewPanel } from './components/PreviewPanel';
import { ProgressPanel } from './components/ProgressPanel';
import { ResultsDashboard } from './components/ResultsDashboard';
import { SiteGrabLogo } from './components/SiteGrabLogo';
import { TermsView } from './components/TermsView';
import {
  auth,
  clearUserSnapshots,
  getAuthHeaders,
  getUserSnapshotBundle,
  saveUserSnapshot,
  saveUserSnapshotBundle,
  signOutAccount,
  subscribeToUserSnapshots,
  syncPreviewSessionCookie,
  upsertUserProfile,
} from './firebase';
import type {
  ActiveView,
  CapturedFileEntry,
  CaptureMode,
  CaptureOptions,
  CaptureStats,
  DiagnosticReport,
  HistoryEntry,
  ProgressEvent,
  SavedPreviewBundle,
} from './types';
import {
  formatBytes,
  formatDurationMs,
  formatRelativeTime,
} from './utils/format';

const THEME_STORAGE_KEY = 'sitegrab_theme_v1';

const EMPTY_DIAGNOSTICS: DiagnosticReport = {
  brokenImages: [],
  failedResources: [],
  unresolvedLinks: [],
};

export default function App() {
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(THEME_STORAGE_KEY);
      if (saved === 'light') return false;
      return true;
    } catch {
      return true;
    }
  });

  const [activeView, setActiveView] = useState<ActiveView>('capture');
  const [urlInput, setUrlInput] = useState('');
  const [crawlDepth, setCrawlDepth] = useState<number>(0);
  const [maxPages, setMaxPages] = useState<number>(5);
  const [formatCode, setFormatCode] = useState<boolean>(true);
  const [recoverSourceMaps, setRecoverSourceMaps] = useState<boolean>(true);
  const [includeImages, setIncludeImages] = useState<boolean>(true);
  const [includeFonts, setIncludeFonts] = useState<boolean>(true);
  const [mobileViewport, setMobileViewport] = useState<boolean>(false);
  const [saveScreenshots, setSaveScreenshots] = useState<boolean>(false);
  const [preserveInternalNav, setPreserveInternalNav] = useState<boolean>(true);
  const [autoDownload, setAutoDownload] = useState<boolean>(false);

  const [chromiumMissing, setChromiumMissing] = useState<boolean>(false);
  const [isCapturing, setIsCapturing] = useState<boolean>(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activePreviewToken, setActivePreviewToken] = useState<string | null>(null);
  const [activeHostname, setActiveHostname] = useState<string>('');
  const [siteTitle, setSiteTitle] = useState<string>('');
  const [zipFilename, setZipFilename] = useState<string>('');
  const [capturedFiles, setCapturedFiles] = useState<CapturedFileEntry[]>([]);
  const [diagnostics, setDiagnostics] = useState<DiagnosticReport>(EMPTY_DIAGNOSTICS);
  const [hasOriginalScreenshot, setHasOriginalScreenshot] = useState<boolean>(false);
  const [progressEvent, setProgressEvent] = useState<ProgressEvent | null>(null);
  const [errorState, setErrorState] = useState<{ code?: string; message: string } | null>(null);
  const [isDownloading, setIsDownloading] = useState<boolean>(false);
  const [downloadPercent, setDownloadPercent] = useState<number | null>(null);
  const [downloadComplete, setDownloadComplete] = useState<boolean>(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [quickMode, setQuickMode] = useState<'none' | 'screenshot' | 'zip'>('none');
  const [quickShotNotes, setQuickShotNotes] = useState<string>('');
  const [quickUploadError, setQuickUploadError] = useState<string | null>(null);
  const [isProcessingUpload, setIsProcessingUpload] = useState<boolean>(false);

  const [authReady, setAuthReady] = useState<boolean>(false);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [pendingVerificationUser, setPendingVerificationUser] = useState<User | null>(null);
  const [showAccountModal, setShowAccountModal] = useState<boolean>(false);
  const [, setProfileVersion] = useState<number>(0);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyPreview, setHistoryPreview] = useState<HistoryPreviewWorkspace | null>(null);
  const [loadingHistoryPreviewId, setLoadingHistoryPreviewId] = useState<string | null>(null);
  const [historyPreviewUnavailableEntry, setHistoryPreviewUnavailableEntry] =
    useState<HistoryEntry | null>(null);
  const [historyPreviewError, setHistoryPreviewError] = useState<string | null>(null);

  const currentUserRef = useRef<User | null>(null);
  currentUserRef.current = currentUser;
  const streamAbortRef = useRef<AbortController | null>(null);
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  const quickShotInputRef = useRef<HTMLInputElement | null>(null);
  const quickZipInputRef = useRef<HTMLInputElement | null>(null);
  const autoDownloadRef = useRef<boolean>(autoDownload);
  autoDownloadRef.current = autoDownload;

  const closeActiveStream = useCallback(() => {
    if (streamAbortRef.current) {
      streamAbortRef.current.abort();
      streamAbortRef.current = null;
    }
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    try {
      localStorage.setItem(THEME_STORAGE_KEY, darkMode ? 'dark' : 'light');
    } catch {
      // Ignore storage errors
    }
  }, [darkMode]);

  useEffect(() => {
    const unsubAuth = onAuthStateChanged(auth, (user) => {
      if (user && user.emailVerified) {
        setCurrentUser(user);
        setPendingVerificationUser(null);
        setAuthReady(true);
        void syncPreviewSessionCookie();
        void upsertUserProfile(user).catch((err) => {
          console.error('Failed to sync user profile:', err);
        });
      } else {
        closeActiveStream();
        setCurrentUser(null);
        setPendingVerificationUser(user ?? null);
        setShowAccountModal(false);
        setAuthReady(true);
        setIsCapturing(false);
        setIsProcessingUpload(false);
        setActiveJobId(null);
        setActivePreviewToken(null);
        setActiveHostname('');
        setSiteTitle('');
        setZipFilename('');
        setCapturedFiles([]);
        setDiagnostics(EMPTY_DIAGNOSTICS);
        setHasOriginalScreenshot(false);
        setProgressEvent(null);
        setErrorState(null);
        setDownloadComplete(false);
        setDownloadError(null);
        setHistory([]);
        setHistoryPreview(null);
        setLoadingHistoryPreviewId(null);
        setHistoryPreviewUnavailableEntry(null);
        setHistoryPreviewError(null);
      }
    });

    return () => {
      unsubAuth();
    };
  }, [closeActiveStream]);

  const handleVerificationComplete = useCallback(async (verifiedUser: User) => {
    setPendingVerificationUser(null);
    setCurrentUser(verifiedUser);
    await syncPreviewSessionCookie();
    await upsertUserProfile(verifiedUser).catch((err) => {
      console.error('Failed to sync user profile after verification:', err);
    });
  }, []);

  useEffect(() => {
    if (!currentUser) return;
    const unsubSnapshots = subscribeToUserSnapshots(
      currentUser.uid,
      (entries) => {
        setHistory(entries);
      },
      (err) => {
        console.error('Failed to subscribe to private snapshots:', err);
      },
    );
    return () => {
      unsubSnapshots();
    };
  }, [currentUser]);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((d: { chromiumInstalled?: boolean }) => {
        if (d && d.chromiumInstalled === false) {
          setChromiumMissing(true);
        }
      })
      .catch(() => {});

    return () => {
      closeActiveStream();
    };
  }, [closeActiveStream]);

  const persistJobBundleToFirestore = useCallback(async (uid: string, jobId: string) => {
    try {
      const authHeaders = await getAuthHeaders();
      const res = await fetch(`/api/capture/${encodeURIComponent(jobId)}/bundle`, {
        headers: authHeaders,
      });
      if (!res.ok) return;
      const bundle = (await res.json()) as SavedPreviewBundle;
      if (Array.isArray(bundle.files) && bundle.files.length > 0) {
        await saveUserSnapshotBundle(uid, jobId, bundle);
      }
    } catch (err) {
      console.error('Failed to persist preview bundle to Firestore:', err);
    }
  }, []);

  const handleSignOut = async () => {
    closeActiveStream();
    setShowAccountModal(false);
    setActiveView('capture');
    await signOutAccount();
  };

  const downloadZipByJobId = useCallback(async (jobId: string, filename: string): Promise<boolean> => {
    setIsDownloading(true);
    setDownloadPercent(0);
    setDownloadError(null);
    try {
      const authHeaders = await getAuthHeaders();
      const res = await fetch(`/api/capture/${encodeURIComponent(jobId)}/download`, {
        cache: 'no-store',
        headers: authHeaders,
      });
      if (!res.ok) {
        let errMsg = `Download failed (HTTP ${res.status}).`;
        try {
          const errJson = (await res.json()) as { error?: string };
          if (errJson.error) errMsg = errJson.error;
        } catch {
          // Keep HTTP status message
        }
        setDownloadError(errMsg);
        return false;
      }

      const contentLengthHeader = res.headers.get('content-length');
      const totalBytes = contentLengthHeader ? Number(contentLengthHeader) : 0;

      let blob: Blob;
      if (res.body) {
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            received += value.length;
            if (totalBytes > 0) {
              setDownloadPercent(Math.min(99, Math.round((received / totalBytes) * 100)));
            }
          }
        }
        setDownloadPercent(100);
        blob = new Blob(chunks as BlobPart[], { type: 'application/zip' });
      } else {
        blob = await res.blob();
        setDownloadPercent(100);
      }

      if (!blob || blob.size === 0) {
        setDownloadError('Received an empty ZIP archive from the server. Please recapture the site.');
        return false;
      }

      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = filename || 'sitegrab-archive.zip';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 15_000);
      setDownloadComplete(true);
      return true;
    } catch {
      setDownloadError('Network error while downloading the ZIP archive. Please click Download ZIP again.');
      return false;
    } finally {
      setIsDownloading(false);
      setDownloadPercent(null);
    }
  }, []);

  const finalizeCapture = async (
    jobId: string,
    event: ProgressEvent,
    targetUrl: string,
    host: string,
    usedOptions: Omit<CaptureOptions, 'url'>,
  ) => {
    let resolvedTitle = host;
    let resolvedZip = `sitegrab-${host}.zip`;
    let resolvedFiles: CapturedFileEntry[] = event.files ?? [];
    let resolvedDiagnostics: DiagnosticReport = event.diagnostics ?? EMPTY_DIAGNOSTICS;
    let resolvedHasShot = Boolean(event.hasOriginalScreenshot);
    let resolvedPreviewToken: string | null = null;

    try {
      await syncPreviewSessionCookie();
      const authHeaders = await getAuthHeaders();
      const statusRes = await fetch(`/api/capture/${encodeURIComponent(jobId)}/status`, {
        headers: authHeaders,
      });
      if (statusRes.ok) {
        const statusData = (await statusRes.json()) as {
          siteTitle?: string;
          zipFilename?: string;
          previewToken?: string;
          files?: CapturedFileEntry[];
          diagnostics?: DiagnosticReport;
          hasOriginalScreenshot?: boolean;
        };
        if (statusData.siteTitle) resolvedTitle = statusData.siteTitle;
        if (statusData.zipFilename) resolvedZip = statusData.zipFilename;
        if (statusData.previewToken) resolvedPreviewToken = statusData.previewToken;
        if (Array.isArray(statusData.files)) resolvedFiles = statusData.files;
        if (statusData.diagnostics) resolvedDiagnostics = statusData.diagnostics;
        if (typeof statusData.hasOriginalScreenshot === 'boolean') {
          resolvedHasShot = statusData.hasOriginalScreenshot;
        }
      }
    } catch {
      // Fall back to SSE event payload
    }

    setSiteTitle(resolvedTitle);
    setZipFilename(resolvedZip);
    setActivePreviewToken(resolvedPreviewToken);
    setCapturedFiles(resolvedFiles);
    setDiagnostics(resolvedDiagnostics);
    setHasOriginalScreenshot(resolvedHasShot);
    setProgressEvent(event);

    const newEntry: HistoryEntry = {
      id: jobId,
      url: targetUrl,
      hostname: host,
      siteTitle: resolvedTitle,
      zipFilename: resolvedZip,
      capturedAt: Date.now(),
      stats: event.stats,
      options: usedOptions,
    };

    const user = currentUserRef.current;
    if (user) {
      void saveUserSnapshot(user.uid, newEntry)
        .then(() => persistJobBundleToFirestore(user.uid, jobId))
        .catch((err) => {
          console.error('Failed to persist snapshot to Firestore:', err);
        });
    }

    if (autoDownloadRef.current) {
      await downloadZipByJobId(jobId, resolvedZip);
    }
  };

  const executeCapture = useCallback(
    async (rawTargetUrl: string, customOptions?: Omit<CaptureOptions, 'url'>) => {
      const trimmed = rawTargetUrl.trim();
      if (!trimmed) {
        setErrorState({
          code: 'INVALID_URL',
          message: 'Please enter a valid http:// or https:// URL.',
        });
        return;
      }

      const normalizedInput = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
        ? trimmed
        : `https://${trimmed}`;

      const opts: Omit<CaptureOptions, 'url'> = customOptions ?? {
        crawlDepth,
        maxPages: crawlDepth > 0 ? maxPages : 1,
        formatCode,
        recoverSourceMaps,
        includeImages,
        includeFonts,
        mobileViewport,
        saveScreenshots,
        preserveInternalNav,
      };

      closeActiveStream();
      setErrorState(null);
      setProgressEvent(null);
      setActiveJobId(null);
      setActivePreviewToken(null);
      setCapturedFiles([]);
      setDiagnostics(EMPTY_DIAGNOSTICS);
      setHasOriginalScreenshot(false);
      setDownloadComplete(false);
      setDownloadError(null);
      setIsCapturing(true);

      try {
        const authHeaders = await getAuthHeaders();
        const response = await fetch('/api/capture', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders,
          },
          body: JSON.stringify({
            url: normalizedInput,
            ...opts,
          }),
        });

        const data = (await response.json()) as {
          jobId?: string;
          url?: string;
          hostname?: string;
          error?: string;
          errorCode?: string;
        };

        if (!response.ok || !data.jobId) {
          setIsCapturing(false);
          setErrorState({
            code: data.errorCode || (response.status === 429 ? 'RATE_LIMITED' : 'CAPTURE_FAILED'),
            message: data.error || 'Could not start capture job.',
          });
          return;
        }

        const jobId = data.jobId;
        const host = data.hostname || '';
        const resolvedUrl = data.url || normalizedInput;
        setUrlInput(resolvedUrl);
        setActiveJobId(jobId);
        setActiveHostname(host);
        setSiteTitle(host);
        setZipFilename(`sitegrab-${host}.zip`);

        const controller = new AbortController();
        streamAbortRef.current = controller;

        const streamHeaders = await getAuthHeaders();
        const sseRes = await fetch(`/api/capture/${encodeURIComponent(jobId)}/events`, {
          headers: streamHeaders,
          signal: controller.signal,
        });

        if (!sseRes.ok || !sseRes.body) {
          throw new Error('Could not open capture progress stream.');
        }

        const reader = sseRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let finished = false;

        while (!finished) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let sepIndex: number;
          while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
            const rawChunk = buffer.slice(0, sepIndex);
            buffer = buffer.slice(sepIndex + 2);

            const dataLine = rawChunk
              .split('\n')
              .find((line) => line.startsWith('data:'));
            if (!dataLine) continue;

            try {
              const evt = JSON.parse(dataLine.slice(5).trim()) as ProgressEvent;
              if (evt.stage === 'ready') {
                finished = true;
                controller.abort();
                streamAbortRef.current = null;
                setIsCapturing(false);
                await finalizeCapture(jobId, evt, resolvedUrl, host, opts);
                break;
              } else if (evt.stage === 'error') {
                finished = true;
                controller.abort();
                streamAbortRef.current = null;
                setProgressEvent(evt);
                setIsCapturing(false);
                setErrorState({
                  code: evt.errorCode,
                  message: evt.message,
                });
                break;
              } else {
                setProgressEvent(evt);
              }
            } catch {
              // Ignore malformed event line
            }
          }
        }

        if (!finished && !controller.signal.aborted) {
          setIsCapturing(false);
          setErrorState((prev) =>
            prev ?? {
              code: 'CONNECTION_LOST',
              message: 'Lost live progress connection. Click Retry to try again.',
            },
          );
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
        setIsCapturing(false);
        setErrorState({
          code: 'NETWORK_ERROR',
          message: 'Could not reach the SiteGrab server. Please check your connection and retry.',
        });
      }
    },
    [
      closeActiveStream,
      crawlDepth,
      maxPages,
      formatCode,
      recoverSourceMaps,
      includeImages,
      includeFonts,
      mobileViewport,
      saveScreenshots,
      preserveInternalNav,
    ],
  );

  const handleStartCapture = (e: FormEvent) => {
    e.preventDefault();
    void executeCapture(urlInput);
  };

  const handleRecoveryRetry = (recovery: RecoveryRetrySettings) => {
    void executeCapture(urlInput, {
      crawlDepth,
      maxPages: crawlDepth > 0 ? maxPages : 1,
      formatCode,
      recoverSourceMaps,
      includeImages,
      includeFonts,
      mobileViewport,
      saveScreenshots,
      preserveInternalNav,
      timeoutMs: recovery.timeoutMs,
      waitStrategy: recovery.waitStrategy,
    });
  };

  const handleUploadZip = async (file: File) => {
    closeActiveStream();
    setDownloadComplete(false);
    setDownloadError(null);

    const authHeaders = await getAuthHeaders();
    const res = await fetch('/api/capture/import-zip', {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/zip',
        'X-Zip-Filename': file.name,
        'X-Format-Code': String(formatCode),
        'X-Include-Images': String(includeImages),
        'X-Include-Fonts': String(includeFonts),
        'X-Preserve-Nav': String(preserveInternalNav),
      },
      body: file,
    });

    const data = (await res.json()) as {
      jobId?: string;
      url?: string;
      hostname?: string;
      siteTitle?: string;
      zipFilename?: string;
      previewToken?: string;
      event?: ProgressEvent;
      error?: string;
    };

    if (!res.ok || !data.jobId || !data.event) {
      throw new Error(data.error || 'Could not extract the uploaded ZIP archive.');
    }

    await syncPreviewSessionCookie();

    const host = data.hostname || 'imported-site';
    const resolvedZip = data.zipFilename || `sitegrab-${host}.zip`;
    const resolvedTitle = data.siteTitle || host;
    const evt = data.event;

    setErrorState(null);
    setActiveJobId(data.jobId);
    setActivePreviewToken(data.previewToken ?? null);
    setActiveHostname(host);
    setSiteTitle(resolvedTitle);
    setZipFilename(resolvedZip);
    setCapturedFiles(evt.files ?? []);
    setDiagnostics(evt.diagnostics ?? EMPTY_DIAGNOSTICS);
    setHasOriginalScreenshot(false);
    setProgressEvent(evt);

    const importedEntry: HistoryEntry = {
      id: data.jobId,
      url: data.url || `zip://${file.name}`,
      hostname: host,
      siteTitle: resolvedTitle,
      zipFilename: resolvedZip,
      capturedAt: Date.now(),
      stats: evt.stats,
      options: {
        crawlDepth: 0,
        maxPages: 1,
        formatCode,
        recoverSourceMaps: false,
        includeImages,
        includeFonts,
        mobileViewport: false,
        saveScreenshots: false,
        preserveInternalNav,
      },
    };
    const user = currentUserRef.current;
    if (user) {
      void saveUserSnapshot(user.uid, importedEntry)
        .then(() => persistJobBundleToFirestore(user.uid, data.jobId!))
        .catch((err) => {
          console.error('Failed to persist ZIP snapshot to Firestore:', err);
        });
    }

    if (autoDownloadRef.current) {
      await downloadZipByJobId(data.jobId, resolvedZip);
    }
  };

  const handleUploadScreenshot = async (file: File, notes?: string) => {
    closeActiveStream();
    setErrorState(null);
    setDownloadComplete(false);
    setDownloadError(null);
    setCapturedFiles([]);
    setDiagnostics(EMPTY_DIAGNOSTICS);
    setActiveJobId(null);
    setActivePreviewToken(null);
    setActiveHostname(file.name);
    setProgressEvent({
      jobId: 'screenshot-pending',
      stage: 'capturing',
      message: `Analyzing ${file.name} and generating responsive HTML, CSS & JS...`,
      percent: 42,
      detail: 'Converting screenshot layout into clean VS Code-ready files',
      stats: {
        pagesCaptured: 0,
        assetsCaptured: 0,
        htmlCount: 0,
        cssCount: 0,
        jsCount: 0,
        imagesCount: 0,
        fontsCount: 0,
        otherAssetsCount: 0,
        totalBytes: 0,
        sourceMapsRecovered: 0,
        skippedRobots: 0,
        failedAssetsCount: 0,
        screenshotsCount: 0,
        durationMs: 0,
      },
    });

    const authHeaders = await getAuthHeaders();
    const headers: Record<string, string> = {
      ...authHeaders,
      'Content-Type': file.type || 'image/png',
      'X-Screenshot-Filename': file.name,
      'X-Format-Code': String(formatCode),
    };
    if (notes && notes.trim()) {
      headers['X-Screenshot-Notes'] = notes.trim().slice(0, 1200);
    }

    const res = await fetch('/api/capture/from-screenshot', {
      method: 'POST',
      headers,
      body: file,
    });

    const data = (await res.json()) as {
      jobId?: string;
      url?: string;
      hostname?: string;
      siteTitle?: string;
      zipFilename?: string;
      previewToken?: string;
      event?: ProgressEvent;
      error?: string;
    };

    if (!res.ok || !data.jobId || !data.event) {
      setProgressEvent(null);
      throw new Error(data.error || 'Could not generate website from the uploaded screenshot.');
    }

    await syncPreviewSessionCookie();

    const host = data.hostname || 'screenshot-site';
    const resolvedZip = data.zipFilename || `sitegrab-${host}.zip`;
    const resolvedTitle = data.siteTitle || host;
    const evt = data.event;

    setErrorState(null);
    setActiveJobId(data.jobId);
    setActivePreviewToken(data.previewToken ?? null);
    setActiveHostname(host);
    setSiteTitle(resolvedTitle);
    setZipFilename(resolvedZip);
    setCapturedFiles(evt.files ?? []);
    setDiagnostics(evt.diagnostics ?? EMPTY_DIAGNOSTICS);
    setHasOriginalScreenshot(Boolean(evt.hasOriginalScreenshot ?? true));
    setProgressEvent(evt);
    setQuickMode('none');

    const generatedEntry: HistoryEntry = {
      id: data.jobId,
      url: data.url || `screenshot://${file.name}`,
      hostname: host,
      siteTitle: resolvedTitle,
      zipFilename: resolvedZip,
      capturedAt: Date.now(),
      stats: evt.stats,
      options: {
        crawlDepth: 0,
        maxPages: 1,
        formatCode,
        recoverSourceMaps: false,
        includeImages: true,
        includeFonts: true,
        mobileViewport: false,
        saveScreenshots: false,
        preserveInternalNav: true,
      },
    };
    const user = currentUserRef.current;
    if (user) {
      void saveUserSnapshot(user.uid, generatedEntry)
        .then(() => persistJobBundleToFirestore(user.uid, data.jobId!))
        .catch((err) => {
          console.error('Failed to persist screenshot snapshot to Firestore:', err);
        });
    }

    if (autoDownloadRef.current) {
      await downloadZipByJobId(data.jobId, resolvedZip);
    }
  };

  const handleQuickShotChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!/\.(png|jpe?g|webp|gif)$/i.test(file.name) && !file.type.startsWith('image/')) {
      setQuickUploadError('Please select a PNG, JPEG, WebP, or GIF image.');
      return;
    }
    setQuickUploadError(null);
    setIsProcessingUpload(true);
    try {
      await handleUploadScreenshot(file, quickShotNotes);
    } catch (err) {
      setQuickUploadError(
        err instanceof Error ? err.message : 'Could not generate website from screenshot.',
      );
    } finally {
      setIsProcessingUpload(false);
    }
  };

  const handleQuickZipChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.zip')) {
      setQuickUploadError('Please select a valid .zip archive.');
      return;
    }
    setQuickUploadError(null);
    setIsProcessingUpload(true);
    try {
      await handleUploadZip(file);
      setQuickMode('none');
    } catch (err) {
      setQuickUploadError(
        err instanceof Error ? err.message : 'Could not process the uploaded ZIP.',
      );
    } finally {
      setIsProcessingUpload(false);
    }
  };

  const handleLoadFromHistory = (entry: HistoryEntry, autoRun = false) => {
    const restoredOpts: Omit<CaptureOptions, 'url'> = {
      crawlDepth: entry.options.crawlDepth ?? 0,
      maxPages: entry.options.maxPages ?? 5,
      formatCode: entry.options.formatCode ?? true,
      recoverSourceMaps: entry.options.recoverSourceMaps ?? true,
      includeImages: entry.options.includeImages ?? true,
      includeFonts: entry.options.includeFonts ?? true,
      mobileViewport: entry.options.mobileViewport ?? false,
      saveScreenshots: entry.options.saveScreenshots ?? false,
      preserveInternalNav: entry.options.preserveInternalNav ?? true,
    };

    setUrlInput(entry.url);
    setCrawlDepth(restoredOpts.crawlDepth);
    setMaxPages(restoredOpts.maxPages);
    setFormatCode(restoredOpts.formatCode);
    setRecoverSourceMaps(restoredOpts.recoverSourceMaps);
    setIncludeImages(restoredOpts.includeImages);
    setIncludeFonts(restoredOpts.includeFonts);
    setMobileViewport(restoredOpts.mobileViewport);
    setSaveScreenshots(restoredOpts.saveScreenshots);
    setPreserveInternalNav(restoredOpts.preserveInternalNav);
    setErrorState(null);
    setActiveView('capture');

    if (autoRun) {
      void executeCapture(entry.url, restoredOpts);
    }
  };

  const restoreWorkspaceForHistoryEntry = useCallback(
    async (entry: HistoryEntry): Promise<HistoryPreviewWorkspace | null> => {
      const user = currentUserRef.current;
      const authHeaders = await getAuthHeaders();

      // 1. Check if workspace is active in server memory or disk cache
      try {
        const statusRes = await fetch(`/api/capture/${encodeURIComponent(entry.id)}/status`, {
          headers: authHeaders,
        });
        if (statusRes.ok) {
          const statusData = (await statusRes.json()) as ProgressEvent & {
            siteTitle?: string;
            hostname?: string;
            zipFilename?: string;
            previewToken?: string;
          };
          if (statusData.stage === 'ready') {
            return {
              entryId: entry.id,
              jobId: entry.id,
              previewToken: statusData.previewToken ?? null,
              siteTitle: statusData.siteTitle || entry.siteTitle || entry.hostname,
              hostname: statusData.hostname || entry.hostname,
              zipFilename: statusData.zipFilename || entry.zipFilename,
              event: statusData,
              files: statusData.files ?? [],
              diagnostics: statusData.diagnostics ?? EMPTY_DIAGNOSTICS,
              hasOriginalScreenshot: Boolean(statusData.hasOriginalScreenshot),
            };
          }
        }
      } catch {
        // Fall through to Firestore saved bundle restoration
      }

      // 2. Restore saved source bundle from private Firestore snapshot subcollection
      if (!user) return null;
      const savedBundle = await getUserSnapshotBundle(user.uid, entry.id);
      if (!savedBundle || savedBundle.files.length === 0) {
        return null;
      }

      const restoreRes = await fetch('/api/capture/restore', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({
          snapshotId: entry.id,
          url: entry.url,
          hostname: entry.hostname,
          siteTitle: entry.siteTitle,
          zipFilename: entry.zipFilename,
          captureMode: savedBundle.captureMode,
          stats: entry.stats,
          options: entry.options,
          files: savedBundle.files,
        }),
      });

      if (!restoreRes.ok) {
        return null;
      }

      const restored = (await restoreRes.json()) as {
        jobId: string;
        previewToken?: string;
        event: ProgressEvent;
        siteTitle?: string;
        hostname?: string;
        zipFilename?: string;
        files?: CapturedFileEntry[];
        diagnostics?: DiagnosticReport;
        hasOriginalScreenshot?: boolean;
        captureMode?: CaptureMode;
      };

      return {
        entryId: entry.id,
        jobId: restored.jobId,
        previewToken: restored.previewToken ?? null,
        siteTitle: restored.siteTitle || entry.siteTitle || entry.hostname,
        hostname: restored.hostname || entry.hostname,
        zipFilename: restored.zipFilename || entry.zipFilename,
        event: {
          ...restored.event,
          captureMode: restored.captureMode ?? savedBundle.captureMode,
        },
        files: restored.files ?? [],
        diagnostics: restored.diagnostics ?? EMPTY_DIAGNOSTICS,
        hasOriginalScreenshot: Boolean(restored.hasOriginalScreenshot),
      };
    },
    [],
  );

  const handlePreviewHistoryEntry = async (entry: HistoryEntry) => {
    setLoadingHistoryPreviewId(entry.id);
    setHistoryPreviewUnavailableEntry(null);
    setHistoryPreviewError(null);
    setDownloadComplete(false);
    setDownloadError(null);

    try {
      await syncPreviewSessionCookie();
      const workspace = await restoreWorkspaceForHistoryEntry(entry);
      if (workspace) {
        setHistoryPreview(workspace);
      } else {
        setHistoryPreview(null);
        setHistoryPreviewUnavailableEntry(entry);
      }
    } catch (err) {
      setHistoryPreview(null);
      setHistoryPreviewUnavailableEntry(entry);
      setHistoryPreviewError(
        err instanceof Error ? err.message : 'Unable to load preview for this history project.',
      );
    } finally {
      setLoadingHistoryPreviewId(null);
    }
  };

  const handleDownloadFromHistory = async (entry: HistoryEntry) => {
    const ok = await downloadZipByJobId(entry.id, entry.zipFilename);
    if (ok) return;

    // Try restoring from saved Firestore preview bundle before falling back to Recapture
    try {
      const workspace = await restoreWorkspaceForHistoryEntry(entry);
      if (workspace) {
        const restoredOk = await downloadZipByJobId(workspace.jobId, workspace.zipFilename);
        if (restoredOk) return;
      }
    } catch {
      // Fall through cleanly to recapture prompt
    }

    handleLoadFromHistory(entry, false);
    setErrorState({
      code: 'EXPIRED',
      message: `The temporary server archive for ${entry.hostname} has expired. Click Retry Capture to regenerate it with your saved settings.`,
    });
  };

  const handleWorkspaceUpdated = (payload: {
    files: CapturedFileEntry[];
    stats: CaptureStats;
    appliedFiles: string[];
  }) => {
    setCapturedFiles(payload.files);
    setDownloadComplete(false);
    setProgressEvent((prev) =>
      prev
        ? {
            ...prev,
            stats: payload.stats,
            files: payload.files,
          }
        : prev,
    );
    const user = currentUserRef.current;
    if (user && activeJobId) {
      void persistJobBundleToFirestore(user.uid, activeJobId);
    }
  };

  const handleHistoryWorkspaceUpdated = (
    jobId: string,
    payload: {
      files: CapturedFileEntry[];
      stats: CaptureStats;
      appliedFiles: string[];
    },
  ) => {
    setDownloadComplete(false);
    setHistoryPreview((prev) =>
      prev && prev.jobId === jobId
        ? {
            ...prev,
            files: payload.files,
            event: {
              ...prev.event,
              stats: payload.stats,
              files: payload.files,
            },
          }
        : prev,
    );
    const user = currentUserRef.current;
    if (user) {
      void persistJobBundleToFirestore(user.uid, jobId);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900 dark:bg-[#0B0F17] dark:text-slate-100">
      {/* Three-Zone Top Bar */}
      <header className="border-b border-slate-200 dark:border-slate-800/80 bg-white/90 dark:bg-[#0B0F17]/90 backdrop-blur-sm sticky top-0 z-20">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-8 px-4 sm:px-6 py-3.5">
          {/* Zone 1: Brand wordmark */}
          <button
            type="button"
            onClick={() => setActiveView('capture')}
            className="inline-flex items-center gap-2.5 font-display text-lg font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <SiteGrabLogo size="sm" />
            <span>SiteGrab</span>
          </button>

          {/* Zone 2: Concise single-line navigation links */}
          <nav aria-label="Primary navigation" className="flex items-center gap-6 text-sm font-medium">
            {currentUser && (
              <>
                <button
                  type="button"
                  onClick={() => setActiveView('capture')}
                  className={`whitespace-nowrap shrink-0 transition-colors cursor-pointer pb-0.5 border-b-2 ${
                    activeView === 'capture'
                      ? 'border-sky-500 text-slate-900 dark:text-slate-100'
                      : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                  }`}
                >
                  Capture
                </button>
                <button
                  type="button"
                  onClick={() => setActiveView('history')}
                  className={`whitespace-nowrap shrink-0 transition-colors cursor-pointer pb-0.5 border-b-2 ${
                    activeView === 'history'
                      ? 'border-sky-500 text-slate-900 dark:text-slate-100'
                      : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                  }`}
                >
                  History{history.length > 0 ? ` (${history.length})` : ''}
                </button>
                <button
                  type="button"
                  onClick={() => setActiveView('feedback')}
                  className={`whitespace-nowrap shrink-0 transition-colors cursor-pointer pb-0.5 border-b-2 ${
                    activeView === 'feedback'
                      ? 'border-sky-500 text-slate-900 dark:text-slate-100'
                      : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                  }`}
                >
                  Feedback
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => setActiveView('guide')}
              className={`whitespace-nowrap shrink-0 transition-colors cursor-pointer pb-0.5 border-b-2 ${
                activeView === 'guide'
                  ? 'border-sky-500 text-slate-900 dark:text-slate-100'
                  : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              How to Use
            </button>
            <button
              type="button"
              onClick={() => setActiveView('terms')}
              className={`whitespace-nowrap shrink-0 transition-colors cursor-pointer pb-0.5 border-b-2 ${
                activeView === 'terms'
                  ? 'border-sky-500 text-slate-900 dark:text-slate-100'
                  : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              Terms
            </button>
          </nav>

          {/* Zone 3: Account Controls & Theme Switch */}
          <div className="flex items-center gap-2 shrink-0">
            {currentUser && (
              <>
                <button
                  type="button"
                  onClick={() => setShowAccountModal(true)}
                  aria-label="Open account settings"
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] hover:bg-slate-100 dark:hover:bg-slate-800 px-2.5 py-1.5 text-xs text-slate-700 dark:text-slate-200 transition-colors cursor-pointer"
                >
                  {currentUser.photoURL ? (
                    <img
                      src={currentUser.photoURL}
                      alt={currentUser.displayName || 'Account avatar'}
                      referrerPolicy="no-referrer"
                      className="h-4 w-4 rounded-full object-cover"
                    />
                  ) : (
                    <span className="flex h-4 w-4 items-center justify-center rounded-full bg-sky-600 text-[10px] font-bold text-white">
                      {(currentUser.displayName || currentUser.email || 'U')[0].toUpperCase()}
                    </span>
                  )}
                  <span className="hidden sm:inline max-w-[120px] truncate font-medium">
                    {currentUser.displayName || currentUser.email?.split('@')[0]}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => void handleSignOut()}
                  aria-label="Sign out"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Sign out</span>
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => setDarkMode((prev) => !prev)}
              aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {darkMode ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
              <span>{darkMode ? 'Light' : 'Dark'}</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 px-4 sm:px-6 py-10 sm:py-12">
        {!authReady ? (
          <div className="flex min-h-[45vh] items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-sky-500" />
          </div>
        ) : !currentUser ? (
          activeView === 'terms' ? (
            <TermsView onBackToCapture={() => setActiveView('capture')} />
          ) : activeView === 'guide' ? (
            <GuideView isSignedIn={false} onBackToMain={() => setActiveView('capture')} />
          ) : (
            <AuthGate
              onReadTerms={() => setActiveView('terms')}
              pendingVerificationUser={pendingVerificationUser}
              onVerificationComplete={handleVerificationComplete}
            />
          )
        ) : (
          <>
            {activeView === 'history' && (
              <HistoryView
                history={history}
                activePreview={historyPreview}
                loadingPreviewId={loadingHistoryPreviewId}
                previewUnavailableEntry={historyPreviewUnavailableEntry}
                previewError={historyPreviewError}
                isDownloading={isDownloading}
                downloadPercent={downloadPercent}
                downloadComplete={downloadComplete}
                downloadError={downloadError}
                onPreviewHistoryEntry={(entry) => void handlePreviewHistoryEntry(entry)}
                onClosePreview={() => {
                  setHistoryPreview(null);
                  setHistoryPreviewUnavailableEntry(null);
                  setHistoryPreviewError(null);
                }}
                onRecapture={handleLoadFromHistory}
                onDownloadHistoryEntry={(entry) => void handleDownloadFromHistory(entry)}
                onDownloadActivePreview={(jobId, zipName) =>
                  void downloadZipByJobId(jobId, zipName)
                }
                onWorkspaceUpdated={handleHistoryWorkspaceUpdated}
                onClearHistory={() => {
                  setHistoryPreview(null);
                  setHistoryPreviewUnavailableEntry(null);
                  setHistoryPreviewError(null);
                  if (currentUser) {
                    void clearUserSnapshots(currentUser.uid).catch((err) => {
                      console.error('Failed to clear history:', err);
                    });
                  }
                }}
                onSwitchToCapture={() => setActiveView('capture')}
              />
            )}

            {activeView === 'feedback' && <FeedbackView />}

            {activeView === 'guide' && (
              <GuideView isSignedIn={true} onBackToMain={() => setActiveView('capture')} />
            )}

            {activeView === 'terms' && (
              <TermsView onBackToCapture={() => setActiveView('capture')} />
            )}

            {activeView === 'capture' && (
          <div className="mx-auto max-w-5xl space-y-6">
            {chromiumMissing && (
              <section
                role="alert"
                className="rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 px-5 py-3.5 text-xs text-amber-800 dark:text-amber-300 flex items-center gap-2.5"
              >
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>
                  Headless Chromium binary was not detected on the server. Install it with{' '}
                  <code className="font-mono font-semibold">npx playwright install chromium</code> before capturing.
                </span>
              </section>
            )}

            {/* Hero & Centered URL Input */}
            <section className="text-center">
              <h1
                style={{ textWrap: 'balance' }}
                className="font-display text-3xl sm:text-4xl font-bold tracking-tight text-slate-900 dark:text-slate-100"
              >
                Website capture & offline development studio
              </h1>
              <p className="mx-auto mt-3 max-w-2xl text-sm sm:text-base text-slate-600 dark:text-slate-400 leading-relaxed">
                Capture websites you own with headless Chromium, inspect diagnostics and source files, edit with AI assistance, and export a VS Code-ready ZIP.
              </p>

              {/* URL Form */}
              <form onSubmit={handleStartCapture} className="mx-auto mt-7 max-w-2xl">
                <div className="flex flex-col sm:flex-row gap-2.5">
                  <div className="relative flex-1">
                    <Globe className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                    <input
                      ref={urlInputRef}
                      type="text"
                      inputMode="url"
                      aria-label="Website URL"
                      placeholder="https://example.com"
                      value={urlInput}
                      onChange={(e) => setUrlInput(e.target.value)}
                      disabled={isCapturing}
                      className="h-12 w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#111827] pl-10 pr-4 text-sm font-mono text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-500/20 disabled:opacity-60"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={isCapturing}
                    className="h-12 inline-flex items-center justify-center gap-2 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:bg-sky-600/60 px-6 text-sm font-semibold text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:cursor-wait focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500"
                  >
                    {isCapturing ? (
                      <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                    ) : (
                      <Globe className="h-4 w-4 shrink-0" />
                    )}
                    <span>{isCapturing ? 'Building Files...' : 'Capture Site'}</span>
                  </button>
                </div>

                {/* Permission Notice */}
                <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  <span>
                    Only use this on sites you own or have permission to copy.{' '}
                    <button
                      type="button"
                      onClick={() => setActiveView('terms')}
                      className="underline underline-offset-2 hover:text-amber-800 dark:hover:text-amber-300 cursor-pointer"
                    >
                      Read Terms
                    </button>
                  </span>
                </p>

                {/* Direct Screenshot-to-Site & ZIP Import Triggers */}
                <div className="mt-4 flex flex-wrap items-center justify-center gap-2 text-xs">
                  <span className="text-slate-500 dark:text-slate-400">
                    No link or ZIP?
                  </span>
                  <button
                    type="button"
                    disabled={isCapturing || isProcessingUpload}
                    onClick={() => {
                      setQuickUploadError(null);
                      setQuickMode((prev) => (prev === 'screenshot' ? 'none' : 'screenshot'));
                    }}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 font-medium transition-colors cursor-pointer ${
                      quickMode === 'screenshot'
                        ? 'border-sky-500 bg-sky-600 text-white'
                        : 'border-slate-300 dark:border-slate-700 bg-white dark:bg-[#111827] text-slate-700 dark:text-slate-200 hover:border-sky-500/60'
                    }`}
                  >
                    <ImageIcon className="h-3.5 w-3.5" />
                    <span>Generate from Screenshot</span>
                  </button>
                  <button
                    type="button"
                    disabled={isCapturing || isProcessingUpload}
                    onClick={() => {
                      setQuickUploadError(null);
                      setQuickMode((prev) => (prev === 'zip' ? 'none' : 'zip'));
                    }}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 font-medium transition-colors cursor-pointer ${
                      quickMode === 'zip'
                        ? 'border-sky-500 bg-sky-600 text-white'
                        : 'border-slate-300 dark:border-slate-700 bg-white dark:bg-[#111827] text-slate-700 dark:text-slate-200 hover:border-sky-500/60'
                    }`}
                  >
                    <FileArchive className="h-3.5 w-3.5" />
                    <span>Upload Project ZIP</span>
                  </button>
                </div>

                {quickMode === 'screenshot' && (
                  <div className="mx-auto mt-4 max-w-2xl rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-4 text-left space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                        Screenshot to Website Generator
                      </span>
                      <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                        PNG · JPEG · WebP · GIF (max 10 MB)
                      </span>
                    </div>
                    <input
                      type="text"
                      value={quickShotNotes}
                      onChange={(e) => setQuickShotNotes(e.target.value)}
                      disabled={isProcessingUpload}
                      placeholder="Optional style or feature notes (e.g., Match dark header, interactive tabs)"
                      className="h-9 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0F17] px-3 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:border-sky-500 focus:outline-none"
                    />
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <input
                        ref={quickShotInputRef}
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        onChange={(e) => void handleQuickShotChange(e)}
                        className="hidden"
                        aria-label="Upload website screenshot"
                      />
                      <button
                        type="button"
                        disabled={isProcessingUpload}
                        onClick={() => quickShotInputRef.current?.click()}
                        className="inline-flex items-center gap-2 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-60 px-4 py-2 text-xs font-semibold text-white transition-colors cursor-pointer"
                      >
                        {isProcessingUpload ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Upload className="h-3.5 w-3.5" />
                        )}
                        <span>
                          {isProcessingUpload ? 'Generating Website...' : 'Choose Screenshot & Generate'}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setQuickMode('none')}
                        className="text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 cursor-pointer"
                      >
                        Close
                      </button>
                    </div>
                    {quickUploadError && (
                      <div className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                        {quickUploadError}
                      </div>
                    )}
                  </div>
                )}

                {quickMode === 'zip' && (
                  <div className="mx-auto mt-4 max-w-2xl rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-4 text-left space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                        Import Website Builder ZIP (Bolt, Lovable, GitHub)
                      </span>
                      <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                        .zip archive (max 50 MB)
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <input
                        ref={quickZipInputRef}
                        type="file"
                        accept=".zip,application/zip,application/x-zip-compressed"
                        onChange={(e) => void handleQuickZipChange(e)}
                        className="hidden"
                        aria-label="Upload project ZIP"
                      />
                      <button
                        type="button"
                        disabled={isProcessingUpload}
                        onClick={() => quickZipInputRef.current?.click()}
                        className="inline-flex items-center gap-2 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-60 px-4 py-2 text-xs font-semibold text-white transition-colors cursor-pointer"
                      >
                        {isProcessingUpload ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Upload className="h-3.5 w-3.5" />
                        )}
                        <span>
                          {isProcessingUpload ? 'Extracting ZIP...' : 'Choose .zip Archive'}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setQuickMode('none')}
                        className="text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 cursor-pointer"
                      >
                        Close
                      </button>
                    </div>
                    {quickUploadError && (
                      <div className="rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                        {quickUploadError}
                      </div>
                    )}
                  </div>
                )}
              </form>
            </section>

            {/* Live SSE Progress Bar (directly under URL form so no scrolling needed) */}
            {progressEvent && progressEvent.stage !== 'error' && (
              <ProgressPanel event={progressEvent} targetHostname={activeHostname} />
            )}

            {/* Smart Capture Failure Recovery (shown immediately below URL form when capture fails) */}
            {errorState && !isCapturing && (
              <FailureRecoveryPanel
                errorCode={errorState.code}
                errorMessage={errorState.message}
                targetUrl={urlInput}
                onRetryCapture={handleRecoveryRetry}
                onUploadZip={handleUploadZip}
                onUploadScreenshot={handleUploadScreenshot}
                onFocusUrlInput={() => {
                  urlInputRef.current?.focus();
                  urlInputRef.current?.select();
                }}
                onDismiss={() => setErrorState(null)}
              />
            )}

            {/* Capture Results Dashboard + Preview / Files / Diagnostics / AI Workspace */}
            {progressEvent?.stage === 'ready' && activeJobId && (
              <>
                <ResultsDashboard stats={progressEvent.stats} hostname={activeHostname} />
                <PreviewPanel
                  jobId={activeJobId}
                  previewToken={activePreviewToken}
                  siteTitle={siteTitle}
                  hostname={activeHostname}
                  zipFilename={zipFilename}
                  event={progressEvent}
                  files={capturedFiles}
                  diagnostics={diagnostics}
                  hasOriginalScreenshot={hasOriginalScreenshot}
                  isDownloading={isDownloading}
                  downloadPercent={downloadPercent}
                  downloadComplete={downloadComplete}
                  downloadError={downloadError}
                  onDownload={() => void downloadZipByJobId(activeJobId, zipFilename)}
                  onRecapture={() => void executeCapture(urlInput)}
                  onWorkspaceUpdated={handleWorkspaceUpdated}
                />
              </>
            )}

            {/* Advanced Capture Options Panel */}
            <section
              aria-label="Capture options"
              className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-5 sm:p-6"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 pb-4 border-b border-slate-100 dark:border-slate-800">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                  <SlidersHorizontal className="h-4 w-4 text-slate-400" />
                  <span>Capture Options</span>
                </div>
                <span className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                  Respects robots.txt · Max 100 MB · Max 500 files · 60s timeout
                </span>
              </div>

              {/* Row 1: Crawl & Export Pipeline */}
              <div className="mt-5 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="space-y-2 md:col-span-2 lg:col-span-1">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-slate-700 dark:text-slate-300">
                      Crawl Depth
                    </label>
                    {crawlDepth > 0 && (
                      <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                        <span>Max pages:</span>
                        <select
                          value={maxPages}
                          onChange={(e) => setMaxPages(Number(e.target.value))}
                          disabled={isCapturing}
                          className="rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#0B0F17] px-2 py-0.5 text-xs font-mono text-slate-900 dark:text-slate-100"
                        >
                          <option value={3}>3</option>
                          <option value={5}>5</option>
                          <option value={10}>10</option>
                          <option value={15}>15</option>
                          <option value={25}>25</option>
                        </select>
                      </label>
                    )}
                  </div>

                  <div
                    role="group"
                    aria-label="Crawl depth"
                    className="grid grid-cols-4 gap-1 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#0B0F17] p-1"
                  >
                    {[
                      { value: 0, label: 'Single' },
                      { value: 1, label: 'D1' },
                      { value: 2, label: 'D2' },
                      { value: 3, label: 'D3' },
                    ].map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        disabled={isCapturing}
                        onClick={() => setCrawlDepth(opt.value)}
                        className={`rounded-md py-1.5 text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                          crawlDepth === opt.value
                            ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                            : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <label className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0B0F17]/60 p-3.5 cursor-pointer">
                  <div>
                    <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                      Format Code
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                      Prettier HTML, CSS & JS.
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    checked={formatCode}
                    disabled={isCapturing}
                    onChange={(e) => setFormatCode(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                  />
                </label>

                <label className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0B0F17]/60 p-3.5 cursor-pointer">
                  <div>
                    <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                      Source Maps
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                      Recover <code className="font-mono">/recovered-src</code>.
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    checked={recoverSourceMaps}
                    disabled={isCapturing}
                    onChange={(e) => setRecoverSourceMaps(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                  />
                </label>

                <label className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0B0F17]/60 p-3.5 cursor-pointer">
                  <div>
                    <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                      Auto-Download
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                      Off by default; click Download ZIP.
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    checked={autoDownload}
                    disabled={isCapturing}
                    onChange={(e) => setAutoDownload(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                  />
                </label>
              </div>

              {/* Row 2: Asset & Viewport Controls */}
              <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                <label className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-[#0B0F17]/40 px-3.5 py-2.5 cursor-pointer">
                  <span className="text-xs font-medium text-slate-800 dark:text-slate-200">
                    Include Images
                  </span>
                  <input
                    type="checkbox"
                    checked={includeImages}
                    disabled={isCapturing}
                    onChange={(e) => setIncludeImages(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                  />
                </label>

                <label className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-[#0B0F17]/40 px-3.5 py-2.5 cursor-pointer">
                  <span className="text-xs font-medium text-slate-800 dark:text-slate-200">
                    Include Fonts
                  </span>
                  <input
                    type="checkbox"
                    checked={includeFonts}
                    disabled={isCapturing}
                    onChange={(e) => setIncludeFonts(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                  />
                </label>

                <label className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-[#0B0F17]/40 px-3.5 py-2.5 cursor-pointer">
                  <span className="text-xs font-medium text-slate-800 dark:text-slate-200">
                    Mobile Viewport
                  </span>
                  <input
                    type="checkbox"
                    checked={mobileViewport}
                    disabled={isCapturing}
                    onChange={(e) => setMobileViewport(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                  />
                </label>

                <label className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-[#0B0F17]/40 px-3.5 py-2.5 cursor-pointer">
                  <span className="text-xs font-medium text-slate-800 dark:text-slate-200">
                    Save Screenshots
                  </span>
                  <input
                    type="checkbox"
                    checked={saveScreenshots}
                    disabled={isCapturing}
                    onChange={(e) => setSaveScreenshots(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                  />
                </label>

                <label className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-[#0B0F17]/40 px-3.5 py-2.5 cursor-pointer col-span-2 sm:col-span-1">
                  <span className="text-xs font-medium text-slate-800 dark:text-slate-200">
                    Internal Nav
                  </span>
                  <input
                    type="checkbox"
                    checked={preserveInternalNav}
                    disabled={isCapturing}
                    onChange={(e) => setPreserveInternalNav(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
                  />
                </label>
              </div>
            </section>

            {/* Quick Start 4-Step Guide */}
            <section
              aria-label="Quick start guide"
              className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] p-5 sm:p-6 space-y-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
                  <BookOpen className="h-4 w-4 text-sky-500" />
                  <span>Quick Guide: How to Use SiteGrab</span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setActiveView('guide');
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                  className="text-xs font-medium text-sky-600 dark:text-sky-400 hover:underline cursor-pointer"
                >
                  Open full step-by-step guide →
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
                <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0B0F17]/60 p-3.5 space-y-1">
                  <div className="font-mono text-[11px] font-semibold text-sky-600 dark:text-sky-400">
                    1. INPUT SOURCE
                  </div>
                  <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
                    Paste a website URL, upload a screenshot, or import an exported builder ZIP.
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0B0F17]/60 p-3.5 space-y-1">
                  <div className="font-mono text-[11px] font-semibold text-sky-600 dark:text-sky-400">
                    2. BUILD FILES
                  </div>
                  <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
                    SiteGrab captures pages &amp; assets (or builds a clean fallback clone) into a structured folder.
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0B0F17]/60 p-3.5 space-y-1">
                  <div className="font-mono text-[11px] font-semibold text-sky-600 dark:text-sky-400">
                    3. PREVIEW &amp; AI EDIT
                  </div>
                  <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
                    Test Desktop/Tablet/Mobile viewports, inspect source files, and refine code with the AI Assistant.
                  </p>
                </div>
                <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-[#0B0F17]/60 p-3.5 space-y-1">
                  <div className="font-mono text-[11px] font-semibold text-sky-600 dark:text-sky-400">
                    4. DOWNLOAD &amp; RUN
                  </div>
                  <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
                    Click <strong>Download ZIP</strong> when ready, extract, and open in VS Code or run <code className="font-mono">npx serve .</code>.
                  </p>
                </div>
              </div>
            </section>

            {/* Compact Recent Downloads Strip */}
            {history.length > 0 && (
              <section className="pt-2">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    Recent Snapshots
                  </h2>
                  <button
                    type="button"
                    onClick={() => setActiveView('history')}
                    className="text-xs font-medium text-sky-600 dark:text-sky-400 hover:underline cursor-pointer"
                  >
                    View all ({history.length})
                  </button>
                </div>
                <div className="divide-y divide-slate-200 dark:divide-slate-800 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827]">
                  {history.slice(0, 3).map((entry) => (
                    <div
                      key={entry.id}
                      className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                          {entry.siteTitle || entry.hostname}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-2 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                          <span>{formatRelativeTime(entry.capturedAt)}</span>
                          <span aria-hidden="true">·</span>
                          <span>{entry.stats.pagesCaptured}p</span>
                          <span aria-hidden="true">·</span>
                          <span>{entry.stats.assetsCaptured} assets</span>
                          <span aria-hidden="true">·</span>
                          <span>{formatBytes(entry.stats.zipBytes ?? entry.stats.totalBytes)}</span>
                          {entry.stats.durationMs > 0 && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span>{formatDurationMs(entry.stats.durationMs)}</span>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => void handleDownloadFromHistory(entry)}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                        >
                          <Download className="h-3 w-3" />
                          <span>ZIP</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleLoadFromHistory(entry, true)}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                        >
                          <RotateCcw className="h-3 w-3" />
                          <span>Recapture</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
          </>
        )}
      </main>

      {/* Structured Developer Footer */}
      <footer className="border-t border-slate-200 dark:border-slate-800/80 bg-white/60 dark:bg-[#0B0F17] px-4 sm:px-6 py-8">
        <div className="mx-auto max-w-6xl space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-start">
            {/* Column 1: Brand & Scope */}
            <div className="md:col-span-5 space-y-2">
              <div className="inline-flex items-center gap-2.5 font-display text-base font-bold tracking-tight text-slate-900 dark:text-slate-100">
                <SiteGrabLogo size="sm" />
                <span>SiteGrab</span>
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed max-w-md">
                Website capture and offline development studio powered by headless Chromium. Export VS Code-ready archives, inspect diagnostics, and refine frontend code with AI.
              </p>
              <p className="text-[11px] text-slate-500 dark:text-slate-500">
                Only capture websites you own or have explicit permission to copy.
              </p>
            </div>

            {/* Column 2: Social & Repository Links */}
            <div className="md:col-span-4 space-y-2.5">
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Links
              </div>
              <div className="flex flex-wrap items-center gap-2.5 pt-0.5">
                <a
                  href="https://github.com/rehanwaqar/siteGrab"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 hover:border-sky-500/60 hover:text-sky-600 dark:hover:text-sky-400 transition-colors"
                >
                  <Github className="h-3.5 w-3.5" />
                  <span>GitHub</span>
                  <ExternalLink className="h-3 w-3 opacity-60" />
                </a>
                <a
                  href="https://www.linkedin.com/in/mohammed-waqar-ahmed-38a856322/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-300 hover:border-sky-500/60 hover:text-sky-600 dark:hover:text-sky-400 transition-colors"
                >
                  <Linkedin className="h-3.5 w-3.5" />
                  <span>LinkedIn</span>
                  <ExternalLink className="h-3 w-3 opacity-60" />
                </a>
              </div>
            </div>

            {/* Column 3: Feedback & Quick Links */}
            <div className="md:col-span-3 space-y-2.5">
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Feedback & Workspace
              </div>
              <button
                type="button"
                onClick={() => {
                  setActiveView('feedback');
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-lg border border-sky-500/40 bg-sky-500/10 hover:bg-sky-500/20 px-3.5 py-2 text-xs font-semibold text-sky-700 dark:text-sky-300 transition-colors cursor-pointer"
              >
                <MessageSquarePlus className="h-3.5 w-3.5 shrink-0" />
                <span>Share Experience & Ideas</span>
              </button>
              <div className="flex flex-wrap items-center gap-4 pt-1 text-xs text-slate-500 dark:text-slate-400">
                <button
                  type="button"
                  onClick={() => {
                    setActiveView('guide');
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                  className="hover:text-slate-900 dark:hover:text-slate-200 transition-colors cursor-pointer"
                >
                  How to Use
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setActiveView('history');
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                  className="hover:text-slate-900 dark:hover:text-slate-200 transition-colors cursor-pointer"
                >
                  Project History
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setActiveView('terms');
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                  className="hover:text-slate-900 dark:hover:text-slate-200 transition-colors cursor-pointer"
                >
                  Terms of Use
                </button>
              </div>
            </div>
          </div>

          <div className="border-t border-slate-200/80 dark:border-slate-800/70 pt-4 flex flex-col sm:flex-row items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-500">
            <span>
              Have an idea to improve SiteGrab?{' '}
              <button
                type="button"
                onClick={() => {
                  setActiveView('feedback');
                  window.scrollTo({ top: 0, behavior: 'smooth' });
                }}
                className="text-sky-600 dark:text-sky-400 hover:underline cursor-pointer"
              >
                Send feedback
              </button>
            </span>
            <span className="font-mono">Static capture · Local preview · VS Code ZIP</span>
          </div>
        </div>
      </footer>
      {currentUser && showAccountModal && (
        <AccountModal
          user={currentUser}
          snapshotsCount={history.length}
          onClose={() => setShowAccountModal(false)}
          onProfileUpdated={() => setProfileVersion((v) => v + 1)}
          onSignOut={() => void handleSignOut()}
        />
      )}
    </div>
  );
}
