import React from 'react';
import { X, Copy, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SessionStatus, ConversationStatus } from '@/lib/api';

export interface SessionInspectorPanelProps {
  open: boolean;
  onClose: () => void;

  // Lifecycle
  sessionId: string | null;
  status: 'starting' | 'active' | 'ended' | undefined;
  /** Raw connection axis from useSessionLifecycle. See docs/session-lifecycle.md. */
  sessionStatus: SessionStatus;
  /** Raw turn axis. Null whenever sessionStatus !== 'started'. */
  conversationStatus: ConversationStatus | null;
  mode: 'rich' | 'tui';
  model: string;
  account: { name: string; configDir: string } | null;
  projectPath: string | null;
  branch: string | null;

  // Workload (promptStatus rollup)
  promptStatus: 'working' | 'ready';
  mainTurnInFlight: boolean;
  activeAgents: number;
  tasks: { total: number; inProgress: number; completed: number; pending: number };
}

/**
 * Right-side drawer that surfaces this session's live properties:
 *   - Lifecycle (status / mode / model / GUID / account / project / branch)
 *   - Workload (promptStatus + its three inputs)
 *
 * Pure presentational. Parent (ClaudeCodeSession) wires every prop from the
 * same state the rest of the chat reads, so the panel mirrors reality with
 * no separate fetches or polling.
 */
export const SessionInspectorPanel: React.FC<SessionInspectorPanelProps> = ({
  open,
  onClose,
  sessionId,
  status,
  sessionStatus,
  conversationStatus,
  mode,
  model,
  account,
  projectPath,
  branch,
  promptStatus,
  mainTurnInFlight,
  activeAgents,
  tasks,
}) => {
  const [copied, setCopied] = React.useState(false);
  const handleCopySessionId = React.useCallback(() => {
    if (!sessionId) return;
    navigator.clipboard.writeText(sessionId).then(() => {
      setCopied(true);
      setTimeout(() => { setCopied(false); }, 1500);
    }).catch(() => { /* clipboard blocked — best-effort */ });
  }, [sessionId]);

  if (!open) return null;

  // Outer positioning + sizing is handled by the framer-motion wrapper in
  // ClaudeCodeSession (matches the MCP/Plugins/Permissions panels exactly:
  // `fixed right-0 top-0 h-full w-96 ...`). This component just owns its
  // internal layout.
  return (
    <div
      className="h-full flex flex-col"
      role="dialog"
      aria-label="Session inspector"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/40">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Session Inspector
        </span>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Close inspector"
          title="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        <Section title="Lifecycle">
          <Row label="Status">
            <StatusPill status={status} />
          </Row>
          <Row label="sessionStatus">
            <span className="font-mono text-xs">{sessionStatus}</span>
          </Row>
          <Row label="conversationStatus">
            {conversationStatus === null
              ? <em className="text-muted-foreground text-xs">null</em>
              : <span className="font-mono text-xs">{conversationStatus}</span>}
          </Row>
          <Row label="Mode">
            <span className="font-mono text-xs uppercase tracking-wide">{mode}</span>
          </Row>
          <Row label="Model">
            <span className="font-mono text-xs">{model || <em className="text-muted-foreground">—</em>}</span>
          </Row>
          <Row label="Session ID">
            {sessionId ? (
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="font-mono text-[11px] truncate" title={sessionId}>{sessionId}</span>
                <button
                  type="button"
                  onClick={handleCopySessionId}
                  className="shrink-0 rounded p-1 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                  title={copied ? 'Copied!' : 'Copy'}
                  aria-label="Copy session id"
                >
                  {copied
                    ? <Check className="w-3 h-3 text-emerald-500" />
                    : <Copy className="w-3 h-3" />}
                </button>
              </div>
            ) : (
              <em className="text-muted-foreground text-xs">awaiting init</em>
            )}
          </Row>
          <Row label="Account">
            {account ? (
              <div className="flex flex-col items-end gap-0.5 min-w-0">
                <span className="text-xs">{account.name}</span>
                <span className="font-mono text-[10px] text-muted-foreground truncate" title={account.configDir}>
                  {account.configDir}
                </span>
              </div>
            ) : (
              <em className="text-muted-foreground text-xs">—</em>
            )}
          </Row>
          <Row label="Project">
            {projectPath ? (
              <span className="font-mono text-[11px] truncate" title={projectPath}>{projectPath}</span>
            ) : (
              <em className="text-muted-foreground text-xs">—</em>
            )}
          </Row>
          <Row label="Branch">
            {branch ? (
              <span className="font-mono text-xs">{branch}</span>
            ) : (
              <em className="text-muted-foreground text-xs">—</em>
            )}
          </Row>
        </Section>

        <Section title="Workload">
          <Row label="Prompt status">
            <PromptStatusPill status={promptStatus} />
          </Row>
          <Row label="Waiting on Claude">
            <BoolBadge value={mainTurnInFlight} />
          </Row>
          <Row label="Active subagents">
            <CountBadge value={activeAgents} />
          </Row>
          <Row label="Tasks in progress">
            <CountBadge value={tasks.inProgress} />
          </Row>
          <Row label="Tasks total">
            <span className="font-mono text-xs text-muted-foreground">
              {tasks.completed}/{tasks.total} done · {tasks.pending} pending
            </span>
          </Row>
        </Section>
      </div>
    </div>
  );
};

// --- internals -------------------------------------------------------------

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div>
    <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 px-1">
      {title}
    </h3>
    <div className="rounded border border-border bg-muted/20 divide-y divide-border/60">
      {children}
    </div>
  </div>
);

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-center justify-between gap-3 px-2.5 py-1.5 min-w-0">
    <span className="text-xs text-muted-foreground shrink-0">{label}</span>
    <div className="min-w-0 flex justify-end text-right">{children}</div>
  </div>
);

const StatusPill: React.FC<{ status: SessionInspectorPanelProps['status'] }> = ({ status }) => {
  if (!status) {
    return <span className="text-xs text-muted-foreground">not started</span>;
  }
  const map: Record<NonNullable<SessionInspectorPanelProps['status']>, { label: string; cls: string }> = {
    starting: { label: 'Starting', cls: 'text-amber-300 bg-amber-500/15' },
    active: { label: 'Active', cls: 'text-emerald-400 bg-emerald-500/10' },
    ended: { label: 'Ended', cls: 'text-muted-foreground bg-muted/40' },
  };
  const { label, cls } = map[status];
  return (
    <span className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide', cls)}>
      {label}
    </span>
  );
};

const PromptStatusPill: React.FC<{ status: 'working' | 'ready' }> = ({ status }) => (
  <span
    className={cn(
      'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
      status === 'working' ? 'text-amber-300 bg-amber-500/20' : 'text-emerald-400 bg-emerald-500/10',
    )}
  >
    {status === 'working' && <span className="inline-block h-1.5 w-1.5 rounded-full bg-current animate-pulse" />}
    {status}
  </span>
);

const BoolBadge: React.FC<{ value: boolean }> = ({ value }) => (
  <span
    className={cn(
      'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
      value ? 'text-amber-300 bg-amber-500/15' : 'text-muted-foreground bg-muted/40',
    )}
  >
    {value ? 'yes' : 'no'}
  </span>
);

const CountBadge: React.FC<{ value: number }> = ({ value }) => (
  <span
    className={cn(
      'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-mono font-medium',
      value > 0 ? 'text-amber-300 bg-amber-500/15' : 'text-muted-foreground bg-muted/40',
    )}
  >
    {value}
  </span>
);
