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
  crawlDepth: number;
  maxPages: number;
  formatCode: boolean;
  recoverSourceMaps: boolean;
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

export type ActiveView = 'capture' | 'history' | 'terms';
