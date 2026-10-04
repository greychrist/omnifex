// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const initialize = vi.fn();
const render = vi.fn();
vi.mock('mermaid', () => ({ default: { initialize, render } }));

const { renderMermaid } = await import('@/lib/mermaid/loadMermaid');

beforeEach(() => {
  initialize.mockReset();
  render.mockReset();
});

describe('renderMermaid', () => {
  it('initializes strict, with the theme matching the app theme', async () => {
    render.mockResolvedValue({ svg: '<svg/>' });
    await renderMermaid('flowchart LR\n A-->B', 'light');
    expect(initialize).toHaveBeenLastCalledWith(
      expect.objectContaining({ startOnLoad: false, securityLevel: 'strict', theme: 'default', htmlLabels: false }),
    );
    await renderMermaid('flowchart LR\n A-->B', 'gray');
    expect(initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'dark' }));
  });

  it('returns the svg and gives every render a unique id', async () => {
    render.mockResolvedValue({ svg: '<svg id="x"/>' });
    const a = await renderMermaid('a', 'gray');
    await renderMermaid('b', 'gray');
    expect(a).toBe('<svg id="x"/>');
    const ids = render.mock.calls.map((c) => c[0] as string);
    expect(new Set(ids).size).toBe(2);
  });

  it('runs renders one at a time', async () => {
    let active = 0;
    let maxActive = 0;
    render.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return { svg: '<svg/>' };
    });
    await Promise.all([renderMermaid('a', 'gray'), renderMermaid('b', 'gray'), renderMermaid('c', 'gray')]);
    expect(maxActive).toBe(1);
  });

  it('rejects with mermaid\'s message and does not wedge the queue', async () => {
    render.mockRejectedValueOnce(new Error('Parse error on line 2'));
    await expect(renderMermaid('bad', 'gray')).rejects.toThrow('Parse error on line 2');
    render.mockResolvedValue({ svg: '<svg/>' });
    await expect(renderMermaid('good', 'gray')).resolves.toBe('<svg/>');
  });

  it('removes the scratch element mermaid leaves behind on failure', async () => {
    render.mockImplementationOnce(async (id: string) => {
      const junk = document.createElement('div');
      junk.id = `d${id}`;
      document.body.appendChild(junk);
      throw new Error('boom');
    });
    await expect(renderMermaid('bad', 'gray')).rejects.toThrow('boom');
    expect(document.body.children).toHaveLength(0);
  });
});
