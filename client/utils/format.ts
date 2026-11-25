export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
}

export function formatRelativeTime(timestamp: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSec < 60) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function getFriendlyErrorTitle(errorCode?: string): string {
  switch (errorCode) {
    case 'INVALID_URL':
    case 'INVALID_SCHEME':
      return 'Invalid URL';
    case 'BLOCKED_ADDRESS':
      return 'Blocked Network Address';
    case 'DNS_ERROR':
      return 'Domain Could Not Be Resolved';
    case 'ROBOTS_DISALLOWED':
      return 'Blocked by robots.txt';
    case 'SIZE_LIMIT_EXCEEDED':
      return 'Site Exceeds 100 MB Limit';
    case 'FILE_LIMIT_EXCEEDED':
      return 'Site Exceeds 500 File Limit';
    case 'TIMEOUT':
      return 'Capture Timed Out (60s)';
    case 'RATE_LIMITED':
      return 'Rate Limit Reached';
    case 'NAVIGATION_ERROR':
      return 'Unable to Load Page';
    default:
      return 'Capture Failed';
  }
}
