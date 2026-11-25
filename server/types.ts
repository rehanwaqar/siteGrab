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
}

export interface CaptureStats {
  pagesCaptured: number;
  assetsCaptured: number;
  totalBytes: number;
  zipBytes?: number;
  sourceMapsRecovered: number;
  skippedRobots: number;
}

export interface ProgressEvent {
  jobId: string;
  stage: CaptureStage;
  message: string;
  percent: number;
  detail?: string;
  stats: CaptureStats;
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
  createdAt: number;
  expiresAt: number;
  cleaned: boolean;
  subscribers: Set<(event: ProgressEvent) => void>;
}
