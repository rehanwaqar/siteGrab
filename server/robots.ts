import { safeFetchWithRedirectValidation } from './ssrf.ts';

interface RobotRule {
  allow: boolean;
  pattern: string;
}

export interface RobotsPolicy {
  rules: RobotRule[];
  found: boolean;
}

function parseRobotsTxt(content: string): RobotRule[] {
  const lines = content.split(/\r?\n/);
  const siteGrabRules: RobotRule[] = [];
  const wildcardRules: RobotRule[] = [];

  let activeAgents: string[] = [];
  let seenRuleInGroup = false;

  for (const rawLine of lines) {
    const commentIdx = rawLine.indexOf('#');
    const line = (commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine).trim();
    if (!line) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const directive = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (directive === 'user-agent') {
      if (seenRuleInGroup) {
        activeAgents = [];
        seenRuleInGroup = false;
      }
      activeAgents.push(value.toLowerCase());
    } else if (directive === 'disallow' || directive === 'allow') {
      seenRuleInGroup = true;
      if (!value && directive === 'disallow') {
        // Empty Disallow means allow all
        continue;
      }
      const rule: RobotRule = { allow: directive === 'allow', pattern: value };
      if (activeAgents.includes('sitegrab')) {
        siteGrabRules.push(rule);
      }
      if (activeAgents.includes('*')) {
        wildcardRules.push(rule);
      }
    }
  }

  return siteGrabRules.length > 0 ? siteGrabRules : wildcardRules;
}

function matchesRobotsPattern(pathAndQuery: string, pattern: string): boolean {
  if (!pattern) return false;
  let anchoredEnd = false;
  let cleanPattern = pattern;
  if (cleanPattern.endsWith('$')) {
    anchoredEnd = true;
    cleanPattern = cleanPattern.slice(0, -1);
  }

  const escaped = cleanPattern
    .split('*')
    .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');

  const regex = new RegExp(`^${escaped}${anchoredEnd ? '$' : ''}`);
  return regex.test(pathAndQuery);
}

export function isAllowedByRobots(policy: RobotsPolicy, targetUrl: URL): boolean {
  if (!policy.found || policy.rules.length === 0) return true;
  const targetPath = `${targetUrl.pathname}${targetUrl.search}`;

  let bestMatch: RobotRule | null = null;
  for (const rule of policy.rules) {
    if (matchesRobotsPattern(targetPath, rule.pattern)) {
      if (!bestMatch || rule.pattern.length > bestMatch.pattern.length) {
        bestMatch = rule;
      } else if (rule.pattern.length === bestMatch.pattern.length && rule.allow) {
        bestMatch = rule;
      }
    }
  }

  return bestMatch ? bestMatch.allow : true;
}

export async function fetchRobotsPolicy(
  origin: string,
  validatedHostCache?: Map<string, string[]>,
): Promise<RobotsPolicy> {
  try {
    const robotsUrl = new URL('/robots.txt', origin).toString();
    const { response } = await safeFetchWithRedirectValidation(
      robotsUrl,
      {
        headers: {
          'User-Agent': 'SiteGrab/1.0 (+respecting robots.txt)',
        },
      },
      3,
      validatedHostCache,
    );

    if (!response.ok) {
      return { rules: [], found: false };
    }

    const text = await response.text();
    if (text.length > 512 * 1024) {
      return { rules: [], found: false };
    }

    return {
      rules: parseRobotsTxt(text),
      found: true,
    };
  } catch {
    return { rules: [], found: false };
  }
}
