import React, { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { StreamMessage } from './StreamMessage';
import type { ClaudeStreamMessage } from './AgentExecution';

const MAX_ACTION_LEN = 48;
const MAX_ACTIONS_SHOWN = 5;

function clip(s: string, max = MAX_ACTION_LEN): string {
  if (!s) return '';
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max) + '…';
}

function basename(p: string): string {
  if (!p) return '';
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function actionLabel(name: string, input: any): string {
  const i = input ?? {};
  const lower = (name ?? '').toLowerCase();
  if (lower === 'bash') return `Ran: ${clip(i.command ?? i.description ?? '')}`;
  if (lower === 'read') return `Read ${basename(i.filePath ?? i.file_path ?? '')}`;
  if (lower === 'write') return `Wrote ${basename(i.filePath ?? i.file_path ?? '')}`;
  if (lower === 'edit') return `Edited ${basename(i.file_path ?? '')}`;
  if (lower === 'multiedit') {
    const n = Array.isArray(i.edits) ? i.edits.length : 0;
    const base = basename(i.file_path ?? '');
    return n > 0 ? `Edited ${base} (${n})` : `Edited ${base}`;
  }
  if (lower === 'grep') return `Searched "${clip(i.pattern ?? '', 30)}"`;
  if (lower === 'glob') return `Glob ${clip(i.pattern ?? '', 30)}`;
  if (lower === 'ls') return `Listed ${basename(i.path ?? '')}`;
  if (lower === 'todowrite') {
    const n = Array.isArray(i.todos) ? i.todos.length : 0;
    return `Updated todos (${n})`;
  }
  if (lower === 'task') return `Dispatched: ${clip(i.description ?? '')}`;
  if (lower === 'skill') return `Skill: ${clip(i.skill ?? i.name ?? '', 40)}`;
  if (lower === 'websearch') return `Searched web: "${clip(i.query ?? '', 30)}"`;
  if (lower === 'webfetch') return `Fetched ${clip(i.url ?? '', 40)}`;
  if (name?.startsWith?.('mcp__')) return name;
  return name ?? 'tool';
}

function countRenderableContent(messages: ClaudeStreamMessage[]): number {
  let count = 0;
  for (const msg of messages) {
    if (msg.type === 'system') {
      count += 1;
      continue;
    }
    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type === 'tool_use') count += 1;
      else if (b?.type === 'tool_result') count += 1;
      else if (b?.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim().length > 0) {
        count += 1;
      } else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0) {
        count += 1;
      }
    }
  }
  return count;
}

export function summarizeGroup(messages: ClaudeStreamMessage[]): string {
  const actions: string[] = [];
  let thinkingCount = 0;
  let systemCount = 0;

  for (const msg of messages) {
    if (msg.type === 'system') {
      systemCount += 1;
      continue;
    }
    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type === 'tool_use' && typeof b.name === 'string') {
        actions.push(clip(actionLabel(b.name, b.input), 60));
      } else if (b?.type === 'thinking') {
        // Only count thinking blocks that have actual content. SDK emits
        // signature-only { thinking: "", signature: "..." } blocks when the
        // thinking summary is disabled; the renderer drops those, so counting
        // them here produced "1 thought" expanders with nothing inside.
        const text = typeof b.thinking === 'string' ? b.thinking.trim() : '';
        if (text.length > 0) thinkingCount += 1;
      }
    }
  }

  const shown = actions.slice(0, MAX_ACTIONS_SHOWN);
  const overflow = actions.length - shown.length;

  const parts: string[] = [];
  if (thinkingCount > 0) {
    parts.push(`${thinkingCount} thought${thinkingCount === 1 ? '' : 's'}`);
  }
  if (shown.length > 0) {
    const joined = shown.join(' · ');
    parts.push(overflow > 0 ? `${joined} · +${overflow} more` : joined);
  }
  if (parts.length === 0 && systemCount > 0) {
    parts.push(`${systemCount} system event${systemCount === 1 ? '' : 's'}`);
  }

  if (parts.length > 0) return parts.join(' + ');

  // Fallback only counts renderable content blocks. Messages whose content
  // would all be suppressed by the renderer (empty text, empty thinking)
  // are excluded so the summary never promises steps the expander can't show.
  const renderable = countRenderableContent(messages);
  if (renderable === 0) return '';
  return `${renderable} step${renderable === 1 ? '' : 's'}`;
}

interface GroupProps {
  messages: ClaudeStreamMessage[];
  streamMessages: ClaudeStreamMessage[];
  accountType?: string;
  onLinkDetected?: (url: string) => void;
}

export const CollapsibleGroup: React.FC<GroupProps> = ({
  messages,
  streamMessages,
  accountType,
  onLinkDetected,
}) => {
  const [expanded, setExpanded] = useState(false);
  const summary = summarizeGroup(messages);

  // If the group has nothing the renderer can actually show, don't emit a
  // placeholder expander — it would just be an empty disclosure.
  if (!summary) return null;

  return (
    <div className="py-0.5">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex items-start gap-2 w-full text-left hover:bg-foreground/5 rounded px-2 py-1 transition-colors"
      >
        <ChevronRight
          className={cn(
            'w-3 h-3 mt-0.5 text-muted-foreground transition-transform shrink-0',
            expanded && 'rotate-90',
          )}
        />
        <span className="font-mono text-xs text-muted-foreground break-words whitespace-normal">
          {summary}
        </span>
      </button>
      {expanded && (
        <div className="mt-2 ml-[0.3125rem] pl-8 border-l-2 border-border/60 space-y-4">
          {messages.map((message, idx) => (
            <StreamMessage
              key={idx}
              message={message}
              streamMessages={streamMessages}
              accountType={accountType}
              onLinkDetected={onLinkDetected}
              inExpandedGroup
            />
          ))}
        </div>
      )}
    </div>
  );
};
