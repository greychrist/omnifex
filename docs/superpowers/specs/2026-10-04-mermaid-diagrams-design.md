# Mermaid diagrams in the transcript

Status: approved in chat 2026-10-04.

## Goal

Claude can illustrate processes and systems with a ```` ```mermaid ```` fence
and OmniFex draws it: inline, expandable to a full-window viewer with pan and
zoom, downloadable and copyable so it can be handed to a team.

Mermaid is the source language because it is portable (GitHub, Confluence,
Notion and Obsidian draw the same text) and models write it reliably. React
Flow was considered for richer interactivity and deferred; a second renderer
can reuse the same frame later.

## Shape

- `src/lib/markdownComponents.tsx` — the existing fence dispatch gains
  `mermaid` → `MermaidBlock`. A `streaming` option makes the in-flight bubble
  show the source instead, so a half-streamed diagram never flashes a parse
  error.
- `src/lib/mermaid/loadMermaid.ts` — lazy `import('mermaid')`, one shared
  instance, `securityLevel: 'strict'`, theme from the app theme, renders
  serialized (mermaid's `render` is not safe to call concurrently).
- `src/components/diagram/MermaidBlock.tsx` — inline card: drawing, Source
  toggle, Expand, Download (SVG / PNG), Copy (source / image). A syntax error
  shows the source plus mermaid's message, never a blank card.
- `src/components/diagram/DiagramOverlay.tsx` — full-window portal (works
  wherever markdown renders): pan, wheel / pinch zoom, fit, 100%, the same
  toolbar, Esc closes.
- `src/lib/mermaid/svgGraph.ts` — pure: reads a rendered flowchart's nodes
  and edges, computes a node's neighbourhood, applies the highlight.
- `src/lib/diagramExport.ts` — SVG serialisation, PNG at 2×, clipboard image
  only where `ClipboardItem` and a secure context exist (the iPad client over
  plain http hides it).

## Highlighting

Flowcharts only. Clicking a node in the overlay highlights it, its edges and
its neighbours and dims the rest; clicking the background clears it.

It depends on mermaid's rendered SVG, which is not a public API. Verified
against mermaid 12.1 (fixtures in `src/lib/__tests__/fixtures/mermaid/`):

- nodes: `g.node` with `id="<svgId>-flowchart-<nodeId>-<n>"`
- edges: `path[data-edge="true"]` with `data-id="L_<from>_<to>_<n>"`; node ids
  may contain `_`, so the split is resolved against the known node ids
- edge labels: `.edgeLabel` holding an element with the edge's `data-id`

If a future mermaid changes this, the graph reader returns nothing and the
overlay degrades to pan and zoom.

## Prompting

OmniFex passes `--append-system-prompt` telling Claude that ```` ```mermaid ````
fences are rendered, so diagrams work in every account without per-account
`CLAUDE.md` edits.

## Testing

Unit: graph reader against the fixtures, dispatch incl. streaming, block
states with mermaid mocked, overlay open/close, exports. jsdom cannot lay out
SVG, so drawing, pan/zoom, fit, highlighting and PNG export were checked in
Chromium against the real components (renderer-only Vite server plus a
throwaway harness page) — not yet in a packaged Electron build.

Two react-zoom-pan-pinch 4.2 behaviours the viewer works around:
`centerView` mis-centres once a transform is applied (centring is computed
and set with `setTransform`), and an animated transform issued on mount was
intermittently overridden, so the opening fit is instant.
