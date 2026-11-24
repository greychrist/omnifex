import type { ThemeMode } from '@/contexts/ThemeContext';

/**
 * Hex, not oklch: mermaid's color maths cannot parse oklch. Each value is the styles.css token beside it.
 * The neo look must keep the `g.node` ids and `path[data-edge]` data-ids svgGraph reads, and add no `<foreignObject>`.
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

const NOTE = {
  gray: { bkg: '#3a2f17', border: '#7a5a14', text: '#fcd9a0' },
  light: { bkg: '#fff4dc', border: '#f5c46b', text: '#7a4a00' },
} as const;

// A system stack: an exported SVG is opened where the app's webfont does not exist.
const FONT = '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif';

const THEME_CSS = `
  .node rect, .node polygon, .node circle, .node ellipse, .node path { stroke-width: 1px; }
  .node rect { rx: 8px; ry: 8px; }
  .cluster rect { rx: 12px; ry: 12px; stroke-width: 1px; }
  .actor { rx: 8px; ry: 8px; stroke-width: 1px; }
  .note { rx: 6px; ry: 6px; stroke-width: 1px; }
  .labelBkg, .edgeLabel rect { rx: 4px; ry: 4px; }
  .cluster-label text { font-weight: 600; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; }
`;

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
    flowchart: { padding: 14, nodeSpacing: 36, rankSpacing: 48, diagramPadding: 12, wrappingWidth: 280 },
    sequence: { actorMargin: 60, boxMargin: 8, noteMargin: 10, messageMargin: 36, mirrorActors: false },
  };
}
