import type { ThemeMode } from '@/contexts/ThemeContext';

/**
 * The one way the renderer draws mermaid.
 *
 * - Lazy: mermaid is ~1 MB+ of JS, so it is imported on the first diagram,
 *   never at startup.
 * - Strict: the source is model-written text, so `securityLevel: 'strict'`
 *   (no click callbacks, no scripts).
 * - Serial: `mermaid.render` draws into a scratch element in the document and
 *   is not safe to run concurrently, so every call waits for the one before.
 */

type Mermaid = typeof import('mermaid').default;

let mermaidPromise: Promise<Mermaid> | null = null;
let queue: Promise<unknown> = Promise.resolve();
let counter = 0;

function loadMermaid(): Promise<Mermaid> {
  mermaidPromise ??= import('mermaid').then((m) => m.default);
  return mermaidPromise;
}

async function renderNow(source: string, theme: ThemeMode): Promise<string> {
  const mermaid = await loadMermaid();
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: theme === 'light' ? 'default' : 'dark',
    // SVG <text> labels, not <foreignObject> HTML: a canvas that draws an SVG
    // holding foreignObject is tainted in Safari, which would break PNG
    // export, and plain-SVG labels survive being opened in other tools.
    htmlLabels: false,
  });
  counter += 1;
  const id = `omnifex-mermaid-${counter}`;
  try {
    const { svg } = await mermaid.render(id, source);
    return svg;
  } finally {
    // On a parse error mermaid can leave its scratch container (`d<id>`) in
    // the body; on success it removes it itself.
    document.getElementById(`d${id}`)?.remove();
  }
}

/** Draws `source`, resolving to SVG markup or rejecting with mermaid's error. */
export function renderMermaid(source: string, theme: ThemeMode): Promise<string> {
  const run = queue.then(() => renderNow(source, theme));
  queue = run.catch(() => undefined);
  return run;
}
