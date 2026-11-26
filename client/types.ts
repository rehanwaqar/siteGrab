export type CaptureStage =
  | 'queued'
  | 'validating'
  | 'launching'
  | 'capturing'
  | 'recovering'
  | 'rewriting'
  | 'formatting'
  | 'zipping'
  | 'ready'
  | 'error';

export type WaitStrategy = 'networkidle' | 'load' | 'domcontentloaded';

export interface CaptureOptions {
  url: string;
  crawlDepth: number;
  maxPages: number;
  formatCode: boolean;
  recoverSourceMaps: boolean;
  includeImages: boolean;
  includeFonts: boolean;
  mobileViewport: boolean;
  saveScreenshots: boolean;
  preserveInternalNav: boolean;
  timeoutMs?: number;
  waitStrategy?: WaitStrategy;
}

export interface CapturedFileEntry {
  path: string;
  size: number;
}

export interface FailedResourceEntry {
  url: string;
  resourceType: string;
  reason: string;
  status?: number;
}

export interface DiagnosticReport {
  brokenImages: Array<{ src: string; page: string; reason: string }>;
  failedResources: FailedResourceEntry[];
  unresolvedLinks: Array<{ href: string; page: string; type: 'asset' | 'navigation' }>;
}

export interface CaptureStats {
  pagesCaptured: number;
  assetsCaptured: number;
  htmlCount: number;
  cssCount: number;
  jsCount: number;
  imagesCount: number;
  fontsCount: number;
  otherAssetsCount: number;
  totalBytes: number;
  zipBytes?: number;
  sourceMapsRecovered: number;
  skippedRobots: number;
  failedAssetsCount: number;
  screenshotsCount: number;
  durationMs: number;
}

export interface ProgressEvent {
  jobId: string;
  stage: CaptureStage;
  message: string;
  percent: number;
  detail?: string;
  stats: CaptureStats;
  files?: CapturedFileEntry[];
  diagnostics?: DiagnosticReport;
  hasOriginalScreenshot?: boolean;
  errorCode?: string;
}

export interface AiFileEdit {
  filePath: string;
  summary: string;
  updatedContent: string;
}

export interface AiAssistantResult {
  explanation: string;
  edits: AiFileEdit[];
}

export interface HistoryEntry {
  id: string;
  url: string;
  hostname: string;
  siteTitle: string;
  zipFilename: string;
  capturedAt: number;
  stats: CaptureStats;
  options: Omit<CaptureOptions, 'url'>;
}

export type FeedbackCategory =
  | 'Experience'
  | 'Feature Idea'
  | 'UI / UX'
  | 'Capture Engine'
  | 'Bug Report';

export interface FeedbackEntry {
  id: string;
  authorName: string;
  rating: number;
  category: FeedbackCategory;
  experience: string;
  suggestion: string;
  createdAt: number;
}

export interface FeedbackSummary {
  items: FeedbackEntry[];
  averageRating: number | null;
  totalCount: number;
}

export type ActiveView = 'capture' | 'history' | 'feedback' | 'terms';

