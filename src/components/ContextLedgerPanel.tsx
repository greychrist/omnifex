import * as React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  FileText, FolderTree, Server, Bot, Sparkles, Wrench,
} from 'lucide-react';
import { useTheme } from '@/hooks';
import { getClaudeSyntaxTheme } from '@/lib/claudeSyntaxTheme';
import { buildMarkdownComponents } from '@/lib/markdownComponents';
import { cn } from '@/lib/utils';
import { CONTENT_INDENT, GroupHeader, ROW_INDENT } from '@/components/sessionContext/rows';
import { CONTEXT_TRACKING_SINCE, type ContextEntryKind, type ContextLedger, type LedgerEntry } from '@/lib/contextLedger';

/**
 * "What shaped this session, and when did it arrive?" — with the same list
 * answering "and which of those is still in effect?".
 *
 * The ledger is an audit in arrival order; `live` is an overlay on it rather
 * than a second view, so the two readings can never disagree.
 *
 * Read-only by design. "Review" was the ask, and read-only keeps this clear
 * of the editing question entirely — which is why the old ClaudeFileEditor
 * was deleted rather than revived.
 */

interface GroupDef {
  kind: ContextEntryKind;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** High-volume groups start closed. Two `deferred_tools_delta` records
   *  expand to ~197 entries in a real session — open by default, that group
   *  IS the panel. */
  openByDefault: boolean;
}

const GROUPS: readonly GroupDef[] = [
  { kind: 'instruction-file', label: 'Instruction files', icon: FileText, openByDefault: true },
  { kind: 'nested-memory', label: 'Nested memory', icon: FolderTree, openByDefault: true },
  { kind: 'mcp-server', label: 'MCP servers', icon: Server, openByDefault: true },
  { kind: 'agent', label: 'Agents', icon: Bot, openByDefault: false },
  { kind: 'skills', label: 'Skills', icon: Sparkles, openByDefault: false },
  { kind: 'deferred-tool', label: 'Deferred tools', icon: Wrench, openByDefault: false },
];

// ─── rows ───────────────────────────────────────────────────────────────────

type View = 'rendered' | 'source';

/** Files read better by name; the full path stays on the title attribute. */
function displayLabel(e: LedgerEntry): string {
  if (e.kind !== 'instruction-file' && e.kind !== 'nested-memory') return e.label;
  const parts = e.label.split('/');
  return parts[parts.length - 1] || e.label;
}

function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

const PILL_BASE = 'text-[10px] px-2 py-0.5 font-medium transition-colors';
const PILL_ACTIVE = 'bg-foreground/10 text-foreground';
const PILL_INACTIVE = 'text-muted-foreground hover:text-foreground';

function EntryRow({
  entry, expanded, onToggle, view, onViewChange, mdComponents,
}: {
  entry: LedgerEntry;
  expanded: boolean;
  onToggle: () => void;
  view: View;
  onViewChange: (v: View) => void;
  /** Built once by the panel. Built per row, a session with 197 deferred-tool
   *  rows paid for 197 component maps to render the one file that is open. */
  mdComponents: ReturnType<typeof buildMarkdownComponents>;
}): React.JSX.Element {
  const hasContent = typeof entry.content === 'string' && entry.content.length > 0;
  const label = displayLabel(entry);

  return (
    <li className="flex flex-col">
      <div
        data-testid={`entry-${entry.id}`}
        data-live={String(entry.live)}
        title={entry.label}
        onClick={hasContent ? onToggle : undefined}
        {...(hasContent ? { role: 'button', tabIndex: 0, 'aria-expanded': expanded } : {})}
        onKeyDown={hasContent ? (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onToggle(); }
        } : undefined}
        className={cn(
          'flex items-center gap-1.5 rounded py-1 pr-1.5 text-[11px]',
          ROW_INDENT,
          hasContent && 'cursor-pointer hover:bg-muted/60',
          !entry.live && 'opacity-50',
        )}
      >
        <span
          aria-label={entry.live ? 'in effect' : 'no longer in effect'}
          className={cn(
            'h-1.5 w-1.5 flex-none rounded-full',
            entry.live ? 'bg-emerald-400' : 'bg-muted-foreground/40',
          )}
        />
        <span className={cn('truncate', !entry.live && 'line-through')}>{label}</span>
        {entry.scope ? (
          <span className="flex-none rounded bg-muted px-1 text-[9px] uppercase tracking-wide text-muted-foreground">
            {entry.scope}
          </span>
        ) : null}
        <span className="ml-auto flex-none tabular-nums text-[10px] text-muted-foreground/70">
          {entry.live ? timeOf(entry.at) : `ended ${timeOf(entry.endedAt ?? entry.at)}`}
        </span>
      </div>

      {expanded && hasContent ? (
        <div className={cn('mb-1 mr-1.5 flex flex-col gap-1', CONTENT_INDENT)}>
          <div className="flex justify-end">
            <div
              role="group"
              aria-label="View mode"
              className="flex items-center overflow-hidden rounded-md border bg-background/80"
            >
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onViewChange('rendered'); }}
                aria-pressed={view === 'rendered'}
                className={cn(PILL_BASE, view === 'rendered' ? PILL_ACTIVE : PILL_INACTIVE)}
              >
                Rendered
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onViewChange('source'); }}
                aria-pressed={view === 'source'}
                className={cn(PILL_BASE, view === 'source' ? PILL_ACTIVE : PILL_INACTIVE)}
              >
                Source
              </button>
            </div>
          </div>

          {view === 'rendered' ? (
            <div
              data-testid="entry-content-rendered"
              className="prose prose-sm dark:prose-invert max-w-none break-words rounded border bg-background p-2 text-[11px]"
            >
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                {entry.content}
              </ReactMarkdown>
            </div>
          ) : (
            // Plain <pre>, not the syntax highlighter MarkdownBlock uses: these
            // are up to 27,000 characters and the highlighter tokenises the
            // whole string on every render.
            <pre
              data-testid="entry-content-source"
              className="overflow-auto whitespace-pre-wrap rounded border bg-background p-2 text-[10px] leading-relaxed"
            >
              {entry.content}
            </pre>
          )}
        </div>
      ) : null}
    </li>
  );
}

// ─── panel ──────────────────────────────────────────────────────────────────

export interface ContextLedgerPanelProps {
  ledger: ContextLedger;
  /** Entry id to open on mount — how the inline transcript marker points at
   *  its own arrival. Opens the containing group and the entry's content. */
  focusId?: string;
  className?: string;
}

export function ContextLedgerPanel({
  ledger, focusId, className,
}: ContextLedgerPanelProps): React.JSX.Element {
  const [openGroups, setOpenGroups] = React.useState<Record<string, boolean>>(() => {
    const seed: Record<string, boolean> = {};
    for (const g of GROUPS) seed[g.kind] = g.openByDefault;
    if (focusId) {
      const focused = ledger.entries.find(e => e.id === focusId);
      if (focused) seed[focused.kind] = true;
    }
    return seed;
  });
  const [expanded, setExpanded] = React.useState<string | null>(focusId ?? null);
  // A reading preference, so it lives on the panel rather than per row —
  // choosing Source on one file and getting Rendered on the next would be a
  // setting that silently resets.
  const [view, setView] = React.useState<View>('rendered');
  const { theme } = useTheme();
  const mdComponents = React.useMemo(
    () => buildMarkdownComponents(getClaudeSyntaxTheme(theme)),
    [theme],
  );

  if (!ledger.tracked) {
    return (
      <div className={cn('h-full p-3 text-[11px] text-muted-foreground', className)}>
        <p className="font-medium text-foreground">
          {ledger.startedAt === null ? 'Nothing loaded yet' : 'No context record'}
        </p>
        <p className="mt-1 leading-relaxed">
          {ledger.startedAt === null
            ? 'Claude Code reports the instruction files, memory, MCP servers and skills it loads when the first prompt starts.'
            : ledger.startedAt < CONTEXT_TRACKING_SINCE
              ? 'This session predates instruction tracking — the CLI began reporting what it loads in early September 2026. Nothing is missing from the session itself; there is simply no record to show.'
              : 'Claude Code has not reported anything it loaded for this session.'}
        </p>
      </div>
    );
  }

  const byKind = new Map<ContextEntryKind, LedgerEntry[]>();
  for (const e of ledger.entries) {
    const bucket = byKind.get(e.kind);
    if (bucket) bucket.push(e); else byKind.set(e.kind, [e]);
  }

  return (
    <div
      data-testid="context-ledger-panel"
      className={cn('flex h-full flex-col gap-1 p-2', className)}
    >
      {/* Fills the remaining height rather than a fixed max, so a resize
          actually lengthens the list instead of the empty space under it. */}
      <div data-testid="context-ledger-scroll" className="min-h-0 flex-1 overflow-y-auto">
        {GROUPS.map(g => {
          const items = byKind.get(g.kind);
          if (!items || items.length === 0) return null;
          const open = openGroups[g.kind] ?? g.openByDefault;

          return (
            <div key={g.kind} className="mb-1">
              <GroupHeader
                testId={`group-${g.kind}`}
                label={g.label}
                icon={g.icon}
                count={items.length}
                open={open}
                onToggle={() => setOpenGroups(s => ({ ...s, [g.kind]: !open }))}
              />

              {open ? (
                <ul className="mt-0.5">
                  {items.map(e => (
                    <EntryRow
                      key={`${e.id}@${e.at}`}
                      entry={e}
                      expanded={expanded === e.id}
                      onToggle={() => setExpanded(cur => (cur === e.id ? null : e.id))}
                      view={view}
                      onViewChange={setView}
                      mdComponents={mdComponents}
                    />
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })}
      </div>

    </div>
  );
}
