import { describe, it, expect } from 'vitest';
import { prepareSource, accentFor } from '@/lib/mermaid/prepareSource';

describe('prepareSource — HTML in labels', () => {
  // We draw SVG text labels (htmlLabels: false, for PNG export), which print
  // HTML tags literally: `<b> IDEA </b>` on screen. Mermaid's markdown strings
  // render bold/italic in that mode, so tags become markdown.
  it('turns b/i/br in a flowchart label into a markdown string', () => {
    const out = prepareSource('flowchart TD\n  A["<b> IDEA </b><br/>(RTR project)<br/><i>Owner: Joel</i>"] --> B', 'gray');
    expect(out).toContain('A["`**IDEA**\n(RTR project)\n*Owner: Joel*`"]');
  });

  it('accepts strong/em and <br> spellings', () => {
    const out = prepareSource('graph LR\n  A["<strong>x</strong><br>y<BR />z <em>w</em>"]', 'gray');
    expect(out).toContain('A["`**x**\ny\nz *w*`"]');
  });

  it('leaves labels without formatting tags alone, <br/> included', () => {
    const src = 'flowchart TD\n  A["one<br/>two"] --> B["plain"]';
    expect(prepareSource(src, 'gray')).toBe(src);
  });

  it('leaves an existing markdown string alone', () => {
    const src = 'flowchart TD\n  A["`**already**`"]';
    expect(prepareSource(src, 'gray')).toBe(src);
  });

  // Markdown strings are a flowchart feature; elsewhere the tags are dropped
  // so at least they are not printed.
  it('strips formatting tags in other diagram types', () => {
    const out = prepareSource('sequenceDiagram\n  A->>B: <b>hello</b> <i>there</i>', 'gray');
    expect(out).toBe('sequenceDiagram\n  A->>B: hello there');
  });
});

describe('prepareSource — colours', () => {
  // Claude's classDef/style colours override any theme: pastel fills with
  // navy text on a dark card. They are kept as colour-coding but redrawn in
  // OmniFex's own accent grammar — tinted fill, stronger tinted 1px border,
  // the theme's text colour.
  it('maps a classDef colour onto the nearest OmniFex accent, tinted', () => {
    const out = prepareSource('flowchart TD\n  classDef epic fill:#cfe0ff,stroke:#5577cc,stroke-width:2px,color:#112244', 'gray');
    const line = out.split('\n')[1];
    const blue = accentFor('#cfe0ff')!;
    expect(blue.name).toBe('blue');
    expect(line).toBe(`  classDef epic fill:${blue.fill.gray},stroke:${blue.stroke.gray},stroke-width:1px,color:${blue.text.gray}`);
  });

  it('uses the light tints for the light theme', () => {
    const out = prepareSource('flowchart TD\n  style A fill:#e8f5e9', 'light');
    const green = accentFor('#e8f5e9')!;
    expect(out.split('\n')[1]).toBe(`  style A fill:${green.fill.light},stroke:${green.stroke.light},stroke-width:1px,color:${green.text.light}`);
  });

  it('drops greys and unreadable colours back to the theme, keeping other properties', () => {
    const out = prepareSource('flowchart TD\n  classDef sub fill:#f7f7f7,stroke:#999,color:#000,stroke-dasharray: 5 5;', 'gray');
    expect(out.split('\n')[1]).toBe('  classDef sub stroke-dasharray: 5 5');
  });

  it('reads rgb() and 3-digit hex, and falls back to the stroke when there is no fill', () => {
    expect(accentFor('rgb(255, 0, 0)')?.name).toBe('red');
    expect(accentFor('#f60')?.name).toBe('orange');
    expect(prepareSource('flowchart TD\n  style B stroke:#8e51ff', 'gray')).toContain('fill:');
  });

  it('leaves lines that are not styling alone', () => {
    const src = 'flowchart TD\n  A --> B\n  class A epic';
    expect(prepareSource(src, 'gray')).toBe(src);
  });
});
