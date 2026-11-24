/** Reads mermaid's rendered SVG (no public API). Node ids may contain `_`, so edge ids are split against existing node ids. A miss falls back to pan and zoom. */

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
