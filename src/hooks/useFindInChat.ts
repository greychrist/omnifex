import { useCallback, useEffect, useRef, useState } from 'react';

/** DOM-scoped: unrendered content cannot match; `data-find-skip` and hidden ancestors are skipped. */
export interface UseFindInChatArgs {
  containerRef: React.RefObject<HTMLElement | null>;
  query: string;
  isOpen: boolean;
  transcriptVersion: number;
}

export interface UseFindInChatResult {
  count: number;
  /** 0-based. */
  activeIndex: number;
  next: () => void;
  prev: () => void;
}

const DEBOUNCE_MS = 100;
const MARK_ATTR = 'data-find';
const ACTIVE_CLASS = 'is-active';
const SKIP_ATTR = 'data-find-skip';

interface Match { node: Text; offset: number; length: number }

function isSkippedElement(el: Element): boolean {
  const tag = el.tagName;
  if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return true;
  if (tag === 'MARK' && el.hasAttribute(MARK_ATTR)) return true;
  return false;
}

function isVisible(el: Element, cache: WeakMap<Element, boolean>): boolean {
  const cached = cache.get(el);
  if (cached !== undefined) return cached;
  const chain: Element[] = [];
  let cur: Element | null = el;
  let result = true;
  while (cur) {
    const c = cache.get(cur);
    if (c !== undefined) {
      result = c;
      break;
    }
    chain.push(cur);
    const style = cur.ownerDocument?.defaultView?.getComputedStyle(cur);
    if (style && (style.display === 'none' || style.visibility === 'hidden')) {
      result = false;
      break;
    }
    cur = cur.parentElement;
  }
  for (const node of chain) cache.set(node, result);
  return result;
}

function collectMatches(container: HTMLElement, query: string): Match[] {
  const lowered = query.toLowerCase();
  if (!lowered) return [];
  const matches: Match[] = [];
  const visCache = new WeakMap<Element, boolean>();
  const walker = container.ownerDocument.createTreeWalker(
    container,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node: Node): number {
        const parent = (node as Text).parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        let cur: Element | null = parent;
        while (cur && cur !== container.parentElement) {
          if (isSkippedElement(cur)) return NodeFilter.FILTER_REJECT;
          if (cur.hasAttribute(SKIP_ATTR)) return NodeFilter.FILTER_REJECT;
          cur = cur.parentElement;
        }
        if (!isVisible(parent, visCache)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    },
  );
  let n: Node | null = walker.nextNode();
  while (n) {
    const text = (n as Text).data;
    if (text.length > 0) {
      const lower = text.toLowerCase();
      let idx = 0;
      while ((idx = lower.indexOf(lowered, idx)) !== -1) {
        matches.push({ node: n as Text, offset: idx, length: lowered.length });
        idx += lowered.length;
      }
    }
    n = walker.nextNode();
  }
  return matches;
}

/** Back-to-front within a text node so each `splitText` keeps earlier offsets valid. */
function wrapMatches(container: HTMLElement, matches: Match[]): HTMLElement[] {
  if (matches.length === 0) return [];
  const doc = container.ownerDocument;
  const out: HTMLElement[] = [];
  for (let i = matches.length - 1; i >= 0; i--) {
    const { node, offset, length } = matches[i];
    if (!node.parentNode) continue;
    const end = offset + length;
    if (node.length > end) node.splitText(end);
    const matchNode = offset > 0 ? node.splitText(offset) : node;
    const mark = doc.createElement('mark');
    mark.setAttribute(MARK_ATTR, '');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- array index guaranteed valid by upstream length check.
    matchNode.parentNode!.insertBefore(mark, matchNode);
    mark.appendChild(matchNode);
    out.push(mark);
  }
  return out.reverse();
}

function unwrapMarks(container: HTMLElement | null, marks: HTMLElement[]): void {
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
  }
  if (container) container.normalize();
}

function setActiveMark(marks: HTMLElement[], idx: number): void {
  for (let i = 0; i < marks.length; i++) {
    if (i === idx) marks[i].classList.add(ACTIVE_CLASS);
    else marks[i].classList.remove(ACTIVE_CLASS);
  }
}

function scrollMarkIntoView(el: HTMLElement): void {
  // jsdom lacks scrollIntoView.
  if (typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ block: 'center', behavior: 'auto' });
  }
}

export function useFindInChat({
  containerRef,
  query,
  isOpen,
  transcriptVersion,
}: UseFindInChatArgs): UseFindInChatResult {
  const [count, setCount] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const marksRef = useRef<HTMLElement[]>([]);
  const activeIndexRef = useRef(0);
  // Only the first walk after open scrolls; streaming re-walks must not move the reader.
  const hasWalkedSinceOpenRef = useRef(false);

  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);

  const performWalk = useCallback(
    (scroll: boolean) => {
      const container = containerRef.current;
      if (marksRef.current.length > 0) {
        unwrapMarks(container, marksRef.current);
        marksRef.current = [];
      }
      if (!container || !query) {
        setCount(0);
        setActiveIndex(0);
        activeIndexRef.current = 0;
        return;
      }
      const found = collectMatches(container, query);
      const marks = wrapMatches(container, found);
      marksRef.current = marks;
      setCount(marks.length);
      if (marks.length === 0) {
        setActiveIndex(0);
        activeIndexRef.current = 0;
        return;
      }
      let idx = activeIndexRef.current;
      if (idx >= marks.length) idx = 0;
      setActiveIndex(idx);
      activeIndexRef.current = idx;
      setActiveMark(marks, idx);
      if (scroll) scrollMarkIntoView(marks[idx]);
    },
    [containerRef, query],
  );

  useEffect(() => {
    if (!isOpen) return;
    const wasFirstWalk = !hasWalkedSinceOpenRef.current;
    const t = setTimeout(() => {
      performWalk(wasFirstWalk);
      hasWalkedSinceOpenRef.current = true;
    }, DEBOUNCE_MS);
    return () => { clearTimeout(t); };
  }, [isOpen, query, transcriptVersion, performWalk]);

  useEffect(() => {
    if (isOpen) return;
    if (marksRef.current.length > 0) {
      unwrapMarks(containerRef.current, marksRef.current);
      marksRef.current = [];
    }
    setCount(0);
    setActiveIndex(0);
    activeIndexRef.current = 0;
    hasWalkedSinceOpenRef.current = false;
  }, [isOpen, containerRef]);

  // Captured at effect time: the ref may be null by cleanup, but the marks still live in this container.
  useEffect(() => {
    const container = containerRef.current;
    return () => {
      if (marksRef.current.length > 0) {
        unwrapMarks(container, marksRef.current);
        marksRef.current = [];
      }
    };
  }, [containerRef]);

  const next = useCallback(() => {
    const marks = marksRef.current;
    if (marks.length === 0) return;
    const newIdx = (activeIndexRef.current + 1) % marks.length;
    activeIndexRef.current = newIdx;
    setActiveIndex(newIdx);
    setActiveMark(marks, newIdx);
    scrollMarkIntoView(marks[newIdx]);
  }, []);

  const prev = useCallback(() => {
    const marks = marksRef.current;
    if (marks.length === 0) return;
    const len = marks.length;
    const newIdx = (activeIndexRef.current - 1 + len) % len;
    activeIndexRef.current = newIdx;
    setActiveIndex(newIdx);
    setActiveMark(marks, newIdx);
    scrollMarkIntoView(marks[newIdx]);
  }, []);

  return { count, activeIndex, next, prev };
}
