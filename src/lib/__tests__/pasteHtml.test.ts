// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { listPasteToMarkdown } from '../pasteHtml';

describe('listPasteToMarkdown', () => {
  it('returns null when the HTML has no list, so the plain-text paste stands', () => {
    expect(listPasteToMarkdown('<p>hello <b>world</b></p>')).toBeNull();
    expect(listPasteToMarkdown('<span style="color:red">const x = 1;</span>')).toBeNull();
    expect(listPasteToMarkdown('')).toBeNull();
  });

  it('keeps nesting as indented Markdown bullets (Teams-style message)', () => {
    const html = `<!--StartFragment--><div><p>in a gist:</p><p>&nbsp;</p>
      <ul>
        <li>Every ticket MUST have a parent
          <ul>
            <li>All parents are Epics</li>
            <li>Exception 1: subtasks</li>
          </ul>
        </li>
        <li>Releases
          <ul>
            <li>every release should have a CMB
              <ul><li>Note: an audit trail</li></ul>
            </li>
          </ul>
        </li>
      </ul></div><!--EndFragment-->`;
    expect(listPasteToMarkdown(html)).toBe(
      [
        'in a gist:',
        '',
        '- Every ticket MUST have a parent',
        '  - All parents are Epics',
        '  - Exception 1: subtasks',
        '- Releases',
        '  - every release should have a CMB',
        '    - Note: an audit trail',
      ].join('\n'),
    );
  });

  it('numbers ordered lists from their start attribute and indents under the marker', () => {
    const html = '<ol start="3"><li>three<ul><li>sub</li></ul></li><li>four</li></ol>';
    expect(listPasteToMarkdown(html)).toBe('3. three\n   - sub\n4. four');
  });

  it('nests a list that sits directly inside another list (Outlook shape)', () => {
    const html = '<ul><li>a</li><ul><li>b</li></ul><li>c</li></ul>';
    expect(listPasteToMarkdown(html)).toBe('- a\n  - b\n- c');
  });

  it('does not put blank lines inside an item whose text is wrapped in <p>', () => {
    const html = '<ul><li><p>one</p></li><li><p>two</p><ul><li><p>two-a</p></li></ul></li></ul>';
    expect(listPasteToMarkdown(html)).toBe('- one\n- two\n  - two-a');
  });

  it('keeps bold, italic, code, links and headings around the list', () => {
    const html =
      '<h2>Rules</h2><ul><li><strong>MUST</strong> have <em>one</em> <code>parent</code> per <a href="https://x.test/a">ticket</a></li></ul><p>done</p>';
    expect(listPasteToMarkdown(html)).toBe(
      '## Rules\n\n- **MUST** have *one* `parent` per [ticket](https://x.test/a)\n\ndone',
    );
  });

  it('ignores style and script content and collapses source whitespace', () => {
    const html = '<style>li{color:red}</style><ul><li>  a\n   b  </li></ul><script>x()</script>';
    expect(listPasteToMarkdown(html)).toBe('- a b');
  });
});
