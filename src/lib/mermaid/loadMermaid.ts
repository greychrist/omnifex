import type { ThemeMode } from '@/contexts/ThemeContext';
import { mermaidTheme } from './mermaidTheme';
import { prepareSource } from './prepareSource';

/** Lazy (~1 MB), `securityLevel: 'strict'` (model-written source), and serial: `mermaid.render` is not safe to run concurrently. */

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
    ...mermaidTheme(theme),
    // SVG <text>, not <foreignObject>: foreignObject taints the canvas in Safari and breaks PNG export.
    htmlLabels: false,
  });
  counter += 1;
  const id = `omnifex-mermaid-${counter}`;
  try {
    const { svg } = await mermaid.render(id, prepareSource(source, theme));
    return svg;
  } finally {
    // On a parse error mermaid can leave its `d<id>` scratch container in the body.
    document.getElementById(`d${id}`)?.remove();
  }
}

export function renderMermaid(source: string, theme: ThemeMode): Promise<string> {
  const run = queue.then(() => renderNow(source, theme));
  queue = run.catch(() => undefined);
  return run;
}
