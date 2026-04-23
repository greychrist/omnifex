import { describe, it, expect } from 'vitest';
import { classifyNavigation } from '../navigation-policy';

describe('classifyNavigation', () => {
  it('allows file:// (packaged app load)', () => {
    expect(classifyNavigation('file:///Applications/GreyChrist.app/renderer/index.html')).toBe(
      'allow'
    );
  });

  it('allows greychrist-file:// custom protocol', () => {
    expect(classifyNavigation('greychrist-file:///tmp/image.png')).toBe('allow');
  });

  it('allows about:blank', () => {
    expect(classifyNavigation('about:blank')).toBe('allow');
  });

  it('allows same-origin dev server navigation', () => {
    expect(
      classifyNavigation('http://localhost:5173/index.html', {
        devServerUrl: 'http://localhost:5173/',
      })
    ).toBe('allow');
  });

  it('classifies cross-origin http as external', () => {
    expect(
      classifyNavigation('http://example.com/page', {
        devServerUrl: 'http://localhost:5173/',
      })
    ).toBe('external');
  });

  it('classifies https links as external in packaged mode (no dev server)', () => {
    expect(classifyNavigation('https://anthropic.com')).toBe('external');
  });

  it('classifies https links as external even when dev server is set', () => {
    expect(
      classifyNavigation('https://anthropic.com', {
        devServerUrl: 'http://localhost:5173/',
      })
    ).toBe('external');
  });

  it('denies unknown protocols (e.g. javascript:)', () => {
    expect(classifyNavigation('javascript:alert(1)')).toBe('deny');
  });

  it('denies malformed URLs', () => {
    expect(classifyNavigation('not a url')).toBe('deny');
  });

  it('denies empty-ish data: URLs', () => {
    expect(classifyNavigation('data:text/html,<script>1</script>')).toBe('deny');
  });
});
