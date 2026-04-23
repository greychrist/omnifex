export type NavigationDecision = 'allow' | 'external' | 'deny';

export interface NavigationPolicyOptions {
  devServerUrl?: string;
}

const INTERNAL_PROTOCOLS = new Set(['file:', 'greychrist-file:']);

function sameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.host === b.host;
}

export function classifyNavigation(
  url: string,
  options: NavigationPolicyOptions = {}
): NavigationDecision {
  if (url === 'about:blank' || url === '') return 'allow';

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'deny';
  }

  if (INTERNAL_PROTOCOLS.has(parsed.protocol)) return 'allow';

  if (options.devServerUrl) {
    try {
      const dev = new URL(options.devServerUrl);
      if (sameOrigin(parsed, dev)) return 'allow';
    } catch {
      // ignore bad dev URL, fall through
    }
  }

  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    return 'external';
  }

  return 'deny';
}
