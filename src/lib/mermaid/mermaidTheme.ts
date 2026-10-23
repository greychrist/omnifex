import type { ThemeMode } from '@/contexts/ThemeContext';

/**
 * How diagrams look: mermaid's `base` theme painted from the app's own
 * tokens, in its `neo` look (soft shadows), with OmniFex's card shape — 1px
 * borders and the `rounded-md` 8px radius.
 *
 * The stock themes were what made diagrams read as rudimentary — `default`
 * draws lavender boxes in a yellow subgraph, `dark` flat grey slabs — and
 * neither knew anything about the surface they sit on. `base` is the one
 * theme whose colours come entirely from `themeVariables`.
 *
 * Hex, not oklch: mermaid derives shades with its own colour maths, which does
 * not parse oklch. Each value is the styles.css token named beside it,
 * converted. A diagram sits in a `bg-card` box, so a node is the next surface
 * up (`secondary`) with the theme's `border`, the way the app draws a card
 * inside a card; a subgraph is set INTO the card (`background`).
 *
 * Checked in a real browser (2026-10-23) against what depends on mermaid's
 * SVG: the neo look keeps the `g.node` ids and `path[data-edge]` data-ids
 * svgGraph highlights by, and adds no `<foreignObject>` (PNG export).
 */
export const THEME_SURFACES = {
  gray: {
    node: '#22272b', // --color-secondary  oklch(0.27 0.01 240)
    border: '#3d4347', // between --color-border and --color-ring: border alone vanishes on secondary
    text: '#e9f0f5', // --color-foreground oklch(0.95 0.01 240)
    muted: '#8a9095', // --color-muted-foreground oklch(0.65 0.01 240)
    cluster: '#0e1216', // --color-background oklch(0.18 0.01 240)
    clusterBorder: '#2e3437', // --color-border oklch(0.32 0.01 240)
    label: '#191e21', // --color-card oklch(0.23 0.01 240)
  },
  light: {
    node: '#ffffff',
    border: '#d8dfe4', // --color-border oklch(0.90 0.01 240)
    text: '#030609', // --color-foreground oklch(0.12 0.01 240)
    muted: '#50565a', // --color-muted-foreground oklch(0.45 0.01 240)
    cluster: '#e5ecf1', // --color-muted oklch(0.94 0.01 240)
    clusterBorder: '#d8dfe4', // --color-border
    label: '#f3faff', // --color-background oklch(0.98 0.01 240)
  },
} as const satisfies Record<ThemeMode, Record<string, string>>;

/** Notes: the app's amber chip (`bg-amber-500/10 text-amber-500`), over each surface. */
const NOTE = {
  gray: { bkg: '#3a2f17', border: '#7a5a14', text: '#fcd9a0' },
  light: { bkg: '#fff4dc', border: '#f5c46b', text: '#7a4a00' },
} as const;

// A system stack rather than the app's chosen font: an exported SVG is opened
// elsewhere, where the app's webfont does not exist.
const FONT = '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif';

/** The app's card shape: 1px borders, 8px (`rounded-md`) corners. */
const THEME_CSS = `
  .node rect, .node polygon, .node circle, .node ellipse, .node path { stroke-width: 1px; }
  .node rect { rx: 8px; ry: 8px; }
  .cluster rect { rx: 12px; ry: 12px; stroke-width: 1px; }
  .actor { rx: 8px; ry: 8px; stroke-width: 1px; }
  .note { rx: 6px; ry: 6px; stroke-width: 1px; }
  .labelBkg, .edgeLabel rect { rx: 4px; ry: 4px; }
  .cluster-label text { font-weight: 600; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; }
`;

/** The visual half of mermaid's config; loadMermaid adds the safety half. */
export function mermaidTheme(theme: ThemeMode) {
  const p = THEME_SURFACES[theme];
  const n = NOTE[theme];
  return {
    theme: 'base' as const,
    look: 'neo' as const,
    fontFamily: FONT,
    themeCSS: THEME_CSS,
    themeVariables: {
      darkMode: theme === 'gray',
      background: 'transparent',
      fontFamily: FONT,
      fontSize: '14px',
      primaryColor: p.node,
      primaryBorderColor: p.border,
      primaryTextColor: p.text,
      mainBkg: p.node,
      nodeBorder: p.border,
      secondaryColor: p.cluster,
      tertiaryColor: p.cluster,
      lineColor: p.muted,
      textColor: p.text,
      titleColor: p.muted,
      clusterBkg: p.cluster,
      clusterBorder: p.clusterBorder,
      edgeLabelBackground: p.label,
      actorBkg: p.node,
      actorBorder: p.border,
      actorTextColor: p.text,
      actorLineColor: p.clusterBorder,
      signalColor: p.muted,
      signalTextColor: p.text,
      labelBoxBkgColor: p.node,
      labelBoxBorderColor: p.border,
      labelTextColor: p.text,
      activationBkgColor: p.cluster,
      activationBorderColor: p.border,
      noteBkgColor: n.bkg,
      noteBorderColor: n.border,
      noteTextColor: n.text,
    },
    // Markdown labels wrap at 200px by default, which stacked a four-line
    // label into six; 280 keeps a typical label to the lines it was written in.
    flowchart: { padding: 14, nodeSpacing: 36, rankSpacing: 48, diagramPadding: 12, wrappingWidth: 280 },
    // Actors drawn once, at the top: the mirrored row at the bottom doubled
    // a short diagram's height for no information.
    sequence: { actorMargin: 60, boxMargin: 8, noteMargin: 10, messageMargin: 36, mirrorActors: false },
  };
}
