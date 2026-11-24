// Independent flags, never an isMobile boolean: an iPad with a keyboard is touch but not narrow,
// and a thin desktop window is narrow but not touch.

export const NARROW_MAX_WIDTH = 900;

export interface LayoutInputs {
  width: number;
  coarsePointer: boolean;
  remoteMode: 'desktop' | 'web' | null | undefined;
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

export function layoutClassNames(mode: LayoutMode): string[] {
  const out: string[] = [];
  if (mode.narrow) out.push('omnifex-narrow');
  if (mode.touch) out.push('omnifex-touch');
  if (mode.web) out.push('omnifex-web');
  return out;
}

export const ALL_LAYOUT_CLASSES = ['omnifex-narrow', 'omnifex-touch', 'omnifex-web'] as const;
