import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';

interface MessagePanelProps {
  tabId: string;
}

interface JsonlRecord {
  type?: string;
  subtype?: string;
  message?: { role?: string; content?: unknown };
  session_id?: string;
  [key: string]: unknown;
}

export function MessagePanel({ tabId }: MessagePanelProps) {
  const [records, setRecords] = useState<JsonlRecord[]>([]);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const userHasScrolledRef = useRef(false);

  useEffect(() => {
    const unlisten = window.electronAPI.onEvent(
      `session-jsonl:${tabId}`,
      (...args: unknown[]) => {
        const rec = args[0] as JsonlRecord | undefined;
        if (!rec || typeof rec !== 'object') return;
        setRecords((prev) => [...prev, rec]);
      },
    );
    return unlisten;
  }, [tabId]);

  useEffect(() => {
    if (shouldAutoScrollRef.current) {
      const el = scrollerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [records]);

  // Two-threshold hysteresis to prevent false "user scrolled up" detection:
  // - Within 150px of bottom: near bottom, keep/resume auto-scrolling
  // - Beyond 300px: user intentionally scrolled up, stop auto-scrolling
  // - 150–300px: dead zone, no change (prevents flapping from layout shifts)
  const handleScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;

    if (distanceFromBottom < 150) {
      if (userHasScrolledRef.current) {
        shouldAutoScrollRef.current = true;
        userHasScrolledRef.current = false;
      }
    } else if (distanceFromBottom > 300) {
      userHasScrolledRef.current = true;
      shouldAutoScrollRef.current = false;
    }
  };

  return (
    <div ref={scrollerRef} onScroll={handleScroll} className="h-full w-full overflow-y-auto p-3 space-y-2 bg-background">
      {records.map((r, i) => (
        <MessageCard key={i} record={r} />
      ))}
    </div>
  );
}

function MessageCard({ record }: { record: JsonlRecord }) {
  if (record.type === 'user') {
    const content = extractText(record.message?.content);
    return (
      <div className="rounded-md border border-blue-500/30 bg-blue-500/5 p-3">
        <div className="text-xs uppercase tracking-wide text-blue-500/80 mb-1">user</div>
        <ReactMarkdown>{content}</ReactMarkdown>
      </div>
    );
  }
  if (record.type === 'assistant') {
    const content = extractText(record.message?.content);
    return (
      <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
        <div className="text-xs uppercase tracking-wide text-emerald-500/80 mb-1">assistant</div>
        <ReactMarkdown>{content}</ReactMarkdown>
      </div>
    );
  }
  if (record.type === 'result') {
    return (
      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs">
        result · {typeof record.subtype === 'string' ? record.subtype : 'success'}
      </div>
    );
  }
  if (record.type === 'system') {
    return (
      <div className="rounded-md border border-muted bg-muted/30 p-2 text-xs text-muted-foreground">
        system · {typeof record.subtype === 'string' ? record.subtype : 'event'}
      </div>
    );
  }
  return null;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : (c as { text?: string })?.text ?? ''))
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}
