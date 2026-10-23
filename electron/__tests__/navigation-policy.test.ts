import { describe, it, expect } from 'vitest';
import { classifyNavigation } from '../navigation-policy';

describe('classifyNavigation', () => {
  const appIndexUrl = 'file:///Applications/OmniFex.app/renderer/main_window/index.html';

  it("allows the app's own index page (packaged app load)", () => {
    expect(classifyNavigation(appIndexUrl, { appIndexUrl })).toBe('allow');
  });

  it("allows the app's own index page with a hash route", () => {
    expect(classifyNavigation(`${appIndexUrl}#/settings`, { appIndexUrl })).toBe('allow');
  });

  // A transcript link to `/Users/me/report.md` resolves against the packaged
  // page to `file:///Users/me/report.md`. Allowing it replaced the whole app
  // window with the file (2026-10-22).
  it('denies any other file:// page, so a link cannot replace the app window', () => {
    expect(classifyNavigation('file:///Users/me/reports/draft.md', { appIndexUrl })).toBe('deny');
  });

  it('denies file:// when the app index is unknown', () => {
    expect(classifyNavigation('file:///Users/me/reports/draft.md')).toBe('deny');
  });

  // The custom scheme serves images to <img>; it is never a page.
  it('denies greychrist-file:// as a top-level navigation', () => {
    expect(classifyNavigation('greychrist-file:///tmp/image.png', { appIndexUrl })).toBe('deny');
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

  it('allows the dev server index with a hash route', () => {
    expect(
      classifyNavigation('http://localhost:5173/#/x', { devServerUrl: 'http://localhost:5173/' })
    ).toBe('allow');
  });

  // Same failure as file:// in dev: `/Users/...` resolves onto the dev origin.
  it('denies other same-origin dev server paths', () => {
    expect(
      classifyNavigation('http://localhost:5173/Users/me/reports/draft.md', {
        devServerUrl: 'http://localhost:5173/',
      })
    ).toBe('deny');
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
