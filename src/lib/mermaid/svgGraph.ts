/**
 * Reads the graph back out of a flowchart mermaid has already drawn, so the
 * diagram viewer can highlight a node and what it connects to.
 *
 * Mermaid has no public API for this; it reads the rendered SVG instead.
 * Shapes verified against mermaid 12.1 (fixtures in
 * `src/lib/__tests__/fixtures/mermaid/`):
 *
 * - node:  `g.node#<svgId>-flowchart-<nodeId>-<n>`
 * - edge:  `path[data-edge="true"][data-id="L_<from>_<to>_<n>"]`
 * - label: `.edgeLabel` wrapping an element carrying the edge's `data-id`
 *
 * Node ids may contain `_`, so an edge id is split against the node ids that
 * actually exist rather than on the first underscore. If a future mermaid
 * changes any of this the reader finds no graph and the viewer falls back to
 * pan and zoom — highlighting is a nicety, never load-bearing.
 */

export interface DiagramEdge {
  id: string;
  from: string;
  to: string;
}

export interface DiagramGraph {
  nodes: Set<string>;
  edges: DiagramEdge[];
}

export interface Neighborhood {
  nodes: Set<string>;
  edges: Set<string>;
}

const HIGHLIGHT_CLASS = 'diagram-hl';
const HIGHLIGHTING_ATTR = 'data-highlighting';

/** The mermaid node id of a `g.node` element, or null if it is not one. */
export function nodeIdOf(svg: SVGSVGElement, el: Element): string | null {
  const prefix = `${svg.id}-flowchart-`;
  if (!el.id.startsWith(prefix)) return null;
  return el.id.slice(prefix.length).replace(/-\d+$/, '') || null;
}

function splitEdgeId(id: string, nodes: Set<string>): DiagramEdge | null {
  const body = /^L_(.+)_\d+$/.exec(id)?.[1];
  if (!body) return null;
  for (let i = body.indexOf('_'); i !== -1; i = body.indexOf('_', i + 1)) {
    const from = body.slice(0, i);
    const to = body.slice(i + 1);
    if (nodes.has(from) && nodes.has(to)) return { id, from, to };
  }
  return null;
}

/** The flowchart's nodes and edges, or null when the SVG is not a flowchart. */
export function readFlowchartGraph(svg: SVGSVGElement): DiagramGraph | null {
  if (!svg.getAttribute('aria-roledescription')?.startsWith('flowchart')) return null;
  const nodes = new Set<string>();
  for (const el of svg.querySelectorAll('g.node')) {
    const id = nodeIdOf(svg, el);
    if (id) nodes.add(id);
  }
  if (nodes.size === 0) return null;
  const edges: DiagramEdge[] = [];
  for (const el of svg.querySelectorAll('path[data-edge="true"]')) {
    const edge = splitEdgeId(el.getAttribute('data-id') ?? '', nodes);
    if (edge) edges.push(edge);
  }
  return { nodes, edges };
}

/** A node, every edge touching it, and the nodes at those edges' other ends. */
export function neighborhood(graph: DiagramGraph, nodeId: string): Neighborhood {
  const nodes = new Set([nodeId]);
  const edges = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.from === nodeId || edge.to === nodeId) {
      edges.add(edge.id);
      nodes.add(edge.from);
      nodes.add(edge.to);
    }
  }
  return { nodes, edges };
}

/**
 * Marks `nodeId`'s neighbourhood with `.diagram-hl` and flags the SVG with
 * `data-highlighting`, which is what the dimming CSS keys off. Null clears.
 */
export function applyHighlight(
  svg: SVGSVGElement,
  graph: DiagramGraph,
  nodeId: string | null,
): void {
  for (const el of svg.querySelectorAll(`.${HIGHLIGHT_CLASS}`)) el.classList.remove(HIGHLIGHT_CLASS);
  if (nodeId === null || !graph.nodes.has(nodeId)) {
    svg.removeAttribute(HIGHLIGHTING_ATTR);
    return;
  }
  const hood = neighborhood(graph, nodeId);
  svg.setAttribute(HIGHLIGHTING_ATTR, '');
  for (const el of svg.querySelectorAll('g.node')) {
    const id = nodeIdOf(svg, el);
    if (id && hood.nodes.has(id)) el.classList.add(HIGHLIGHT_CLASS);
  }
  for (const el of svg.querySelectorAll('path[data-edge="true"]')) {
    if (hood.edges.has(el.getAttribute('data-id') ?? '')) el.classList.add(HIGHLIGHT_CLASS);
  }
  for (const label of svg.querySelectorAll('.edgeLabel')) {
    const id = label.querySelector('[data-id]')?.getAttribute('data-id');
    if (id && hood.edges.has(id)) label.classList.add(HIGHLIGHT_CLASS);
  }
}
