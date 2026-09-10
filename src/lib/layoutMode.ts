/**
 * Which shape of UI to draw.
 *
 * Three independent facts, not a device list:
 *  - `narrow`: the viewport is phone-or-portrait-iPad width. The session list
 *    is the root, a session is a pushed view, the tab strip hides.
 *  - `touch`:  the primary pointer is coarse. Targets grow, swipe and
 *    pull-to-refresh are on, permission prompts become a sheet.
 *  - `web`:    no preload bridge — served by the daemon. Some affordances
 *    (file dialogs, Finder) do not exist here regardless of size.
 *
 * An iPad in landscape with a Magic Keyboard is `touch` but not `narrow`; a
 * desktop window dragged thin is `narrow` but not `touch`. Both are real and
 * both must look right, which is why these are separate flags rather than an
 * `isMobile` boolean.
 */

/** Below this CSS-pixel width the split layout collapses. iPad portrait is 768–834. */
export const NARROW_MAX_WIDTH = 900;

export interface LayoutInputs {
  width: number;
  coarsePointer: boolean;
  remoteMode: 'electron-legacy' | 'electron-remote' | 'web' | null | undefined;
}

export interface LayoutMode {
  narrow: boolean;
  touch: boolean;
  web: boolean;
}

export function computeLayoutMode(input: LayoutInputs): LayoutMode {
  return {
    narrow: input.width < NARROW_MAX_WIDTH,
    touch: input.coarsePointer,
    web: input.remoteMode === 'web',
  };
}

/** Class names mirrored onto <html> so plain CSS can branch too. */
export function layoutClassNames(mode: LayoutMode): string[] {
  const out: string[] = [];
  if (mode.narrow) out.push('omnifex-narrow');
  if (mode.touch) out.push('omnifex-touch');
  if (mode.web) out.push('omnifex-web');
  return out;
}

export const ALL_LAYOUT_CLASSES = ['omnifex-narrow', 'omnifex-touch', 'omnifex-web'] as const;
