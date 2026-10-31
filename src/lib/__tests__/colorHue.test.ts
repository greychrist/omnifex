import { describe, it, expect } from 'vitest';
import { hexChroma, hexHue } from '../colorHue';

describe('hexHue', () => {
  it('reads the OKLCH hue of a hex colour', () => {
    // sRGB green is oklch(86.6% 0.295 142.5).
    expect(hexHue('#00ff00')).toBeCloseTo(142.5, 0);
    // sRGB red is oklch(62.8% 0.258 29.23).
    expect(hexHue('#ff0000')).toBeCloseTo(29.2, 0);
    expect(hexHue('#0000ff')).toBeCloseTo(264.1, 0);
  });

  it('reads the short and alpha forms by their colour alone', () => {
    expect(hexHue('#f00')).toBeCloseTo(hexHue('#ff0000')!, 5);
    expect(hexHue('#ff000080')).toBeCloseTo(hexHue('#ff0000')!, 5);
  });

  it('keeps the hue between 0 and 360', () => {
    for (const hex of ['#ff00ff', '#ff0080', '#8000ff', '#00ffff']) {
      const h = hexHue(hex)!;
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });

  it('is null for anything that is not a hex colour', () => {
    expect(hexHue('red')).toBeNull();
    expect(hexHue('#12345')).toBeNull();
  });
});

describe('hexChroma', () => {
  it('is about zero for white, greys and black, which have no hue', () => {
    for (const hex of ['#ffffff', '#808080', '#000000', '#fff']) expect(hexChroma(hex)!).toBeLessThan(0.001);
  });

  it('reads a real colour\'s chroma', () => {
    // sRGB red is oklch(62.8% 0.258 29.23).
    expect(hexChroma('#ff0000')).toBeCloseTo(0.258, 2);
  });

  it('is null for anything that is not a hex colour', () => {
    expect(hexChroma('white')).toBeNull();
  });
});
