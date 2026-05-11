import type { ClaudeStreamMessage } from '@/types/claudeStream';
import { getMessageContent } from '@/types/claudeStream';

interface Counts {
  read: number;
  edit: number;
  bash: number;
  search: number;
  web: number;
  task: number;
  todo: number;
  otherTool: number;
  thinking: number;
  toolResult: number;
  systemEvents: number;
  text: number;
}

function emptyCounts(): Counts {
  return {
    read: 0,
    edit: 0,
    bash: 0,
    search: 0,
    web: 0,
    task: 0,
    todo: 0,
    otherTool: 0,
    thinking: 0,
    toolResult: 0,
    systemEvents: 0,
    text: 0,
  };
}

function bucketTool(name: string): keyof Counts {
  const n = (name ?? '').toLowerCase();
  if (n === 'read' || n === 'notebookread') return 'read';
  if (n === 'edit' || n === 'multiedit' || n === 'write' || n === 'notebookedit') return 'edit';
  if (n === 'bash') return 'bash';
  if (n === 'grep' || n === 'glob' || n === 'ls' || n === 'find') return 'search';
  if (n === 'websearch' || n === 'webfetch') return 'web';
  if (n === 'task') return 'task';
  if (n === 'todowrite' || n === 'todoread') return 'todo';
  return 'otherTool';
}

function tally(messages: ClaudeStreamMessage[]): Counts {
  const c = emptyCounts();
  for (const m of messages) {
    if (m.type === 'system') {
      c.systemEvents += 1;
      continue;
    }
    const content = getMessageContent(m);
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use' && typeof b.name === 'string') {
        c[bucketTool(b.name)] += 1;
      } else if (b.type === 'tool_result') {
        c.toolResult += 1;
      } else if (b.type === 'thinking') {
        const t = typeof b.thinking === 'string' ? b.thinking.trim() : '';
        if (t.length > 0) c.thinking += 1;
      } else if (b.type === 'text') {
        const t = typeof b.text === 'string' ? b.text.trim() : '';
        if (t.length > 0) c.text += 1;
      }
    }
  }
  return c;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Build a one-sentence English summary of what's inside a list of hidden
 * messages, e.g. "Read 3 files, edited 2, ran 1 command, processed 4 tool
 * results."
 *
 * Empty list, or a list whose only contents are signature-only thinking
 * blocks and other render-empty noise, returns an empty string. Callers
 * should treat empty as "nothing worth summarizing — drop the expander."
 */
export function summarizeHiddenEvents(messages: ClaudeStreamMessage[]): string {
  if (messages.length === 0) return '';
  const c = tally(messages);
  const parts: string[] = [];

  if (c.read > 0) parts.push(`read ${plural(c.read, 'file', 'files')}`);
  if (c.edit > 0) parts.push(`edited ${plural(c.edit, 'file', 'files')}`);
  if (c.bash > 0) parts.push(`ran ${plural(c.bash, 'command', 'commands')}`);
  if (c.search > 0) parts.push(`searched ${plural(c.search, 'time', 'times')}`);
  if (c.web > 0) parts.push(`fetched ${plural(c.web, 'url', 'urls')} from the web`);
  if (c.task > 0) parts.push(`dispatched ${plural(c.task, 'subagent', 'subagents')}`);
  if (c.todo > 0) parts.push(`updated todos ${c.todo === 1 ? 'once' : `${c.todo} times`}`);
  if (c.otherTool > 0) parts.push(`used ${plural(c.otherTool, 'other tool', 'other tools')}`);
  if (c.thinking > 0) parts.push(`thought ${c.thinking === 1 ? 'once' : `${c.thinking} times`}`);
  if (c.toolResult > 0) parts.push(`processed ${plural(c.toolResult, 'tool result', 'tool results')}`);

  if (parts.length === 0 && c.systemEvents > 0) {
    parts.push(`${plural(c.systemEvents, 'system event', 'system events')}`);
  }
  if (parts.length === 0 && c.text > 0) {
    parts.push(`${plural(c.text, 'message', 'messages')}`);
  }

  if (parts.length === 0) return '';

  // Capitalize first word, join with commas, end with a period.
  const joined = parts.length === 1
    ? parts[0]
    : parts.slice(0, -1).join(', ') + ', ' + parts[parts.length - 1];
  const sentence = joined.charAt(0).toUpperCase() + joined.slice(1) + '.';
  return sentence;
}

/**
 * Count of "events" used in the expander label ("13 Hidden Events: …").
 * One event per renderable content block, plus one per system message.
 * Empty thinking and empty text do not count.
 */
export function countHiddenEvents(messages: ClaudeStreamMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (m.type === 'system') {
      n += 1;
      continue;
    }
    const content = getMessageContent(m);
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use' || b.type === 'tool_result' || b.type === 'image') {
        n += 1;
      } else if (b.type === 'thinking') {
        const t = typeof b.thinking === 'string' ? b.thinking.trim() : '';
        if (t.length > 0) n += 1;
      } else if (b.type === 'text') {
        const t = typeof b.text === 'string' ? b.text.trim() : '';
        if (t.length > 0) n += 1;
      }
    }
  }
  return n;
}
