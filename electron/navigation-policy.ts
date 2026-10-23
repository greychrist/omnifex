export type NavigationDecision = 'allow' | 'external' | 'deny';

export interface NavigationPolicyOptions {
  devServerUrl?: string;
  /** The packaged renderer's `file://…/index.html`. */
  appIndexUrl?: string;
}

function parse(url: string | undefined): URL | null {
  if (!url) return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function sameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.host === b.host;
}

/**
 * The window may only ever show the app's own page. A transcript link to
 * `/Users/me/report.md` resolves against that page — onto `file://` when
 * packaged, onto the dev origin in dev — so allowing the whole protocol or
 * origin let one click replace the app window with the file (2026-10-22).
 * Hash routes are in-page navigations and never reach this policy.
 */
export function classifyNavigation(
  url: string,
  options: NavigationPolicyOptions = {}
): NavigationDecision {
  if (url === 'about:blank' || url === '') return 'allow';

  const parsed = parse(url);
  if (!parsed) return 'deny';

  const app = parse(options.appIndexUrl);
  if (app && sameOrigin(parsed, app) && parsed.pathname === app.pathname) return 'allow';

  const dev = parse(options.devServerUrl);
  if (dev && sameOrigin(parsed, dev)) {
    return parsed.pathname === '/' || parsed.pathname === '/index.html' ? 'allow' : 'deny';
  }

  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    return 'external';
  }

  return 'deny';
}
