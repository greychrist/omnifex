// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readFlowchartGraph, neighborhood, applyHighlight } from '@/lib/mermaid/svgGraph';

function load(name: string): SVGSVGElement {
  const text = readFileSync(path.join(__dirname, 'fixtures/mermaid', `${name}.svg`), 'utf8');
  const host = document.createElement('div');
  host.innerHTML = text;
  return host.querySelector('svg')!;
}

describe('readFlowchartGraph', () => {
  it('reads nodes and edges from a mermaid 12 flowchart', () => {
    const graph = readFlowchartGraph(load('basic'))!;
    expect([...graph.nodes].sort()).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(graph.edges).toEqual([
      { id: 'L_A_B_0', from: 'A', to: 'B' },
      { id: 'L_B_C_0', from: 'B', to: 'C' },
      { id: 'L_B_D_0', from: 'B', to: 'D' },
      { id: 'L_C_E_0', from: 'C', to: 'E' },
      { id: 'L_D_E_0', from: 'D', to: 'E' },
    ]);
  });

  it('splits edge ids correctly when node ids contain underscores', () => {
    const graph = readFlowchartGraph(load('underscores'))!;
    expect([...graph.nodes].sort()).toEqual(['cache', 'db_main', 'my_api']);
    expect(graph.edges).toEqual([
      { id: 'L_my_api_db_main_0', from: 'my_api', to: 'db_main' },
      { id: 'L_my_api_cache_0', from: 'my_api', to: 'cache' },
      { id: 'L_cache_db_main_0', from: 'cache', to: 'db_main' },
    ]);
  });

  it('returns null for diagrams that are not flowcharts', () => {
    expect(readFlowchartGraph(load('sequence'))).toBeNull();
  });
});

describe('neighborhood', () => {
  it('is the node, its edges in both directions and the nodes at their other ends', () => {
    const graph = readFlowchartGraph(load('basic'))!;
    const hood = neighborhood(graph, 'B');
    expect([...hood.nodes].sort()).toEqual(['A', 'B', 'C', 'D']);
    expect([...hood.edges].sort()).toEqual(['L_A_B_0', 'L_B_C_0', 'L_B_D_0']);
  });
});

describe('applyHighlight', () => {
  it('marks the neighbourhood and flags the svg, then clears both', () => {
    const svg = load('basic');
    const graph = readFlowchartGraph(svg)!;

    applyHighlight(svg, graph, 'B');
    expect(svg.hasAttribute('data-highlighting')).toBe(true);
    const marked = [...svg.querySelectorAll('.diagram-hl')];
    const ids = marked.map((el) => el.id || el.getAttribute('data-id'));
    expect(ids).toContain('m1-flowchart-B-1');
    expect(ids).toContain('m1-flowchart-A-0');
    expect(ids).toContain('m1-L_B_C_0');
    expect(ids).not.toContain('m1-flowchart-E-7');
    expect(ids).not.toContain('m1-L_C_E_0');
    // An edge's label follows its edge.
    expect(marked.some((el) => el.classList.contains('edgeLabel'))).toBe(true);

    applyHighlight(svg, graph, null);
    expect(svg.hasAttribute('data-highlighting')).toBe(false);
    expect(svg.querySelectorAll('.diagram-hl')).toHaveLength(0);
  });
});
