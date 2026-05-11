import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Hook for in-transcript text search. The caller passes a ref to a container
 * element; while `isOpen` is true the hook walks the container's text content
 * for `query` (case-insensitive substring), wraps each hit in a
 * `<mark data-find>` span, and exposes navigation over those hits.
 *
 * Search is strictly DOM-scoped: anything that isn't currently rendered (e.g.
 * unmounted React children, collapsed `<details>`, conditionally-rendered
 * tool blocks) cannot match. Elements whose ancestor has the
 * `data-find-skip` attribute, or whose closest ancestor is `display:none` /
 * `visibility:hidden`, are also skipped — this lets the find bar itself
 * carry `data-find-skip` so it doesn't search its own query string.
 *
 * Re-walks are coalesced through a small debounce. The walk runs whenever
 * `query`, `isOpen`, or `transcriptVersion` changes. The caller bumps
 * `transcriptVersion` whenever the chat messages array reference changes so
 * a streaming session keeps its highlight count fresh.
 *
 * See `docs/superpowers/specs/2026-05-11-find-in-chat-design.md`.
 */
export interface UseFindInChatArgs {
  containerRef: React.RefObject<HTMLElement | null>;
  query: string;
  isOpen: boolean;
  /**
   * Bump on every change to the underlying transcript so the hook re-walks
   * while the bar is open. Used as a plain effect dependency.
   */
  transcriptVersion: number;
}

export interface UseFindInChatResult {
  count: number;
  /** 0-based. Meaningless when `count === 0`. */
  activeIndex: number;
  /** Advance to the next hit, wrapping past the end. No-op when `count === 0`. */
  next: () => void;
  /** Retreat to the previous hit, wrapping past the start. No-op when `count === 0`. */
  prev: () => void;
}

const DEBOUNCE_MS = 100;
const MARK_ATTR = 'data-find';
const ACTIVE_CLASS = 'is-active';
const SKIP_ATTR = 'data-find-skip';

type Match = { node: Text; offset: number; length: number };

function isSkippedElement(el: Element): boolean {
  const tag = el.tagName;
  if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return true;
  if (tag === 'MARK' && el.hasAttribute(MARK_ATTR)) return true;
  return false;
}

function isVisible(el: Element, cache: WeakMap<Element, boolean>): boolean {
  const cached = cache.get(el);
  if (cached !== undefined) return cached;
  // Walk ancestors; first hidden ancestor poisons everything below.
  // Cache results as we go so a deep tree only pays one getComputedStyle per
  // node across the whole walk.
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
        // Walk ancestors up to but not including the container's parent.
        // Bail on any skipped tag, on data-find-skip, or on a hidden chain.
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

/**
 * Wraps each match in a `<mark data-find>` and returns the resulting marks in
 * document order. Matches inside the same text node are processed back-to-
 * front so each `splitText` doesn't invalidate earlier offsets.
 */
function wrapMatches(container: HTMLElement, matches: Match[]): HTMLElement[] {
  if (matches.length === 0) return [];
  const doc = container.ownerDocument;
  const out: HTMLElement[] = [];
  // Iterate back to front. `matches` is already in document order.
  for (let i = matches.length - 1; i >= 0; i--) {
    const { node, offset, length } = matches[i];
    // Skip if the node was already split out of existence by a later match
    // (defensive — shouldn't happen given the back-to-front ordering).
    if (!node.parentNode) continue;
    const end = offset + length;
    if (node.length > end) node.splitText(end);
    const matchNode = offset > 0 ? node.splitText(offset) : node;
    const mark = doc.createElement('mark');
    mark.setAttribute(MARK_ATTR, '');
    matchNode.parentNode!.insertBefore(mark, matchNode);
    mark.appendChild(matchNode);
    out.push(mark);
  }
  // We built `out` back-to-front; reverse to restore document order.
  return out.reverse();
}

function unwrapMarks(container: HTMLElement | null, marks: HTMLElement[]): void {
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
  }
  // Coalesce adjacent text nodes produced by splitText so subsequent walks
  // don't see fragmented Text nodes.
  if (container) container.normalize();
}

function setActiveMark(marks: HTMLElement[], idx: number): void {
  for (let i = 0; i < marks.length; i++) {
    if (i === idx) marks[i].classList.add(ACTIVE_CLASS);
    else marks[i].classList.remove(ACTIVE_CLASS);
  }
}

function scrollMarkIntoView(el: HTMLElement): void {
  // jsdom doesn't implement scrollIntoView; guard so tests don't blow up and
  // so the hook is safe in any embedding that lacks layout.
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
  // Tracks whether the current `isOpen=true` session has completed its first
  // walk. The first walk after open scrolls the active hit into view; later
  // walks (driven by transcript changes during streaming) don't, so the
  // user's reading position is preserved.
  const hasWalkedSinceOpenRef = useRef(false);

  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);

  const performWalk = useCallback(
    (scroll: boolean) => {
      const container = containerRef.current;
      // Always unwrap stale marks before walking.
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

  // Debounced re-walk on (isOpen / query / transcriptVersion) changes.
  useEffect(() => {
    if (!isOpen) return;
    const wasFirstWalk = !hasWalkedSinceOpenRef.current;
    const t = setTimeout(() => {
      performWalk(wasFirstWalk);
      hasWalkedSinceOpenRef.current = true;
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [isOpen, query, transcriptVersion, performWalk]);

  // Cleanup when the bar closes — drop all marks and reset state.
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

  // Final cleanup on unmount in case the consumer disappears with the bar
  // still open.
  useEffect(() => {
    return () => {
      if (marksRef.current.length > 0) {
        unwrapMarks(containerRef.current, marksRef.current);
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
