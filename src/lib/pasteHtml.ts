// Teams and Outlook flatten nested lists in text/plain; only list-bearing HTML is converted.

const SKIP = new Set(['STYLE', 'SCRIPT', 'HEAD', 'META', 'TITLE', 'NOSCRIPT', 'TEMPLATE']);
const LISTS = new Set(['UL', 'OL']);
const BLOCKS = new Set([
  'P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'BLOCKQUOTE', 'PRE',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'TBODY', 'THEAD', 'TR', 'LI', 'HR', 'FIGURE',
]);
const BLOCK_SELECTOR = [...BLOCKS, ...LISTS].join(',');

export function listPasteToMarkdown(html: string): string | null {
  if (!/<(ul|ol)\b/i.test(html)) return null;
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  if (!body.querySelector('ul, ol')) return null;
  const lines = renderBlock(body, false);
  const out: string[] = [];
  for (const line of lines) {
    if (line === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(line.replace(/\s+$/, ''));
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

function renderBlock(el: Element, inList: boolean): string[] {
  const lines: string[] = [];
  let buf = '';
  const gap = () => {
    if (!inList && lines.length && lines[lines.length - 1] !== '') lines.push('');
  };
  const flush = () => {
    const text = buf.replace(/[ \t]+/g, ' ');
    buf = '';
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (line) lines.push(line);
    }
  };

  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      buf += collapse(child.textContent ?? '');
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const c = child as Element;
    if (SKIP.has(c.tagName)) continue;
    if (!BLOCKS.has(c.tagName) && !LISTS.has(c.tagName) && !c.querySelector(BLOCK_SELECTOR)) {
      buf += inline(c);
      continue;
    }
    flush();
    let inner: string[];
    if (LISTS.has(c.tagName)) inner = renderList(c);
    else if (c.tagName === 'PRE') inner = ['```', ...(c.textContent ?? '').replace(/\n$/, '').split('\n'), '```'];
    else if (c.tagName === 'HR') inner = ['---'];
    else {
      inner = renderBlock(c, inList).filter((l) => !inList || l !== '');
      const level = /^H([1-6])$/.exec(c.tagName)?.[1];
      if (level && inner.length) inner[0] = `${'#'.repeat(Number(level))} ${inner[0]}`;
      if (c.tagName === 'BLOCKQUOTE') inner = inner.map((l) => (l ? `> ${l}` : '>'));
    }
    if (!inner.length) continue;
    gap();
    lines.push(...inner);
    gap();
  }
  flush();
  return lines;
}

function renderList(list: Element): string[] {
  const ordered = list.tagName === 'OL';
  let n = ordered ? Number(list.getAttribute('start') ?? '1') || 1 : 0;
  const lines: string[] = [];
  let pad = '  ';
  for (const child of Array.from(list.children)) {
    if (LISTS.has(child.tagName)) {
      // Outlook puts a sub-list beside the <li> it belongs to, not inside it.
      lines.push(...renderList(child).map((l) => pad + l));
      continue;
    }
    if (child.tagName !== 'LI') continue;
    const marker = ordered ? `${n++}.` : '-';
    pad = ' '.repeat(marker.length + 1);
    const inner = renderBlock(child, true);
    if (!inner.length) continue;
    lines.push(`${marker} ${inner[0]}`, ...inner.slice(1).map((l) => pad + l));
  }
  return lines;
}

function inline(el: Element): string {
  if (SKIP.has(el.tagName)) return '';
  if (el.tagName === 'BR') return '\n';
  const text = Array.from(el.childNodes)
    .map((n) =>
      n.nodeType === Node.TEXT_NODE
        ? collapse(n.textContent ?? '')
        : n.nodeType === Node.ELEMENT_NODE
          ? inline(n as Element)
          : '',
    )
    .join('');
  if (!text.trim()) return text;
  switch (el.tagName) {
    case 'STRONG':
    case 'B':
      return wrap(text, '**');
    case 'EM':
    case 'I':
      return wrap(text, '*');
    case 'CODE':
      return wrap(text, '`');
    case 'A': {
      const href = el.getAttribute('href') ?? '';
      return /^https?:|^mailto:/i.test(href) && href !== text.trim() ? `[${text.trim()}](${href})` : text;
    }
    default:
      return text;
  }
}

function wrap(text: string, mark: string): string {
  const lead = text.slice(0, text.length - text.trimStart().length);
  const trail = text.slice(text.trimEnd().length);
  return `${lead}${mark}${text.trim()}${mark}${trail}`;
}

function collapse(text: string): string {
  return text.replace(/[\s\u00a0]+/g, ' ');
}
