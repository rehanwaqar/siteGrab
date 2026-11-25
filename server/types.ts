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

export interface CaptureOptions {
  url: string;
  crawlDepth: number; // 0 = single page, 1..3 = follow internal links
  maxPages: number; // 1..25
  formatCode: boolean;
  recoverSourceMaps: boolean;
  respectRobots: boolean;
  includeImages: boolean;
  includeFonts: boolean;
  mobileViewport: boolean;
  saveScreenshots: boolean;
  preserveInternalNav: boolean;
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

export interface CapturedAsset {
  originalUrl: string;
  normalizedUrl: string;
  localRelPath: string; // relative to site root, e.g. assets/css/style-1a2b3c.css
  category: 'html' | 'css' | 'js' | 'images' | 'fonts' | 'data' | 'media';
  contentType: string;
  buffer: Buffer;
}

export interface CaptureJob {
  id: string;
  url: string;
  hostname: string;
  siteTitle: string;
  options: CaptureOptions;
  status: CaptureStage;
  lastEvent: ProgressEvent;
  tempRoot: string;
  siteDir: string;
  zipPath: string;
  zipFilename: string;
  originalScreenshotPath: string;
  hasOriginalScreenshot: boolean;
  files: CapturedFileEntry[];
  diagnostics: DiagnosticReport;
  createdAt: number;
  expiresAt: number;
  cleaned: boolean;
  subscribers: Set<(event: ProgressEvent) => void>;
}
