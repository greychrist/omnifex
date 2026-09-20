import { useEffect, useMemo } from 'react';
import { api, type SessionContextUsage, type TabStatusSummary } from '@/lib/api';
import type { JsonlNode } from '@/types/jsonl';
import type { Subagent } from '@/lib/subagentStreams';
import { getTaskList, summarizeTaskList } from '@/lib/taskList';
import { deriveWaitingFor } from '@/lib/tabWaitingFor';

interface UsePublishTabStatusArgs {
  tabId: string;
  title: string;
  projectPath: string | null;
  /** CLI session GUID, or null before the session has started. */
  sessionId: string | null;
  sessionStarted: boolean;
  isStarting: boolean;
  /** The session's turn axis — `turn.status === 'running'`, mirrored from main. */
  turnRunning: boolean;
  hasError: boolean;
  messages: JsonlNode[];
  /** Subagents already filtered through dismissals — same set the spinner sees. */
  subagents: Subagent[];
  contextUsage: SessionContextUsage | null;
  branch: string | null;
  filesChanged: number;
  filesUntracked: number;
  /**
   * The session's currently-pending permission, if any. Used to derive
   * the popover's "Permission Request" / "Question Waiting" badge. Pass
   * null when nothing is pending.
   */
  pendingPermission: { toolName?: string } | null;
}

/**
 * Publishes this tab's busy/idle summary up to main on every change. Both
 * the status popover and the install gate read from the aggregated list,
 * so the renderer is the single source of truth for "is this tab busy?".
 *
 * On unmount, removes this tab's entry from the aggregator. Tabs in the
 * tab bar are mounted concurrently (`TabContent.tsx` toggles `hidden`),
 * so each ClaudeCodeSession instance publishes throughout its lifetime.
 */
export function usePublishTabStatus({
  tabId,
  title,
  projectPath,
  sessionId,
  sessionStarted,
  isStarting,
  turnRunning,
  hasError,
  messages,
  subagents,
  contextUsage,
  branch,
  filesChanged,
  filesUntracked,
  pendingPermission,
}: UsePublishTabStatusArgs): void {
  const summary: TabStatusSummary = useMemo(() => {
    const tasks = getTaskList(messages);
    const taskSummary = tasks
      ? summarizeTaskList(tasks)
      : { total: 0, done: 0, inProgress: 0, pending: 0, running: false };
    const activeAgents = subagents.reduce(
      (n, s) => (s.status === 'running' ? n + 1 : n),
      0,
    );
    // The main turn is the session's own axis (see docs/session-lifecycle.md)
    // — the same bit useSessionLifecycle folds into conversationStatus, so the
    // tab popover and the in-session spinner can't disagree. Never read off
    // the transcript: a resumed session whose old process died mid-turn
    // loads a transcript that ends open, and is idle.
    const mainTurnInFlight = turnRunning;
    const waitingFor = deriveWaitingFor(pendingPermission);
    // promptStatus: is the agent actually doing work right now?
    // Spec: working iff (waiting on Claude response) OR (any in-progress
    // task) OR (any running subagent). Does NOT include `waitingFor` —
    // a session waiting on the user is "ready" for the user, not working.
    //
    // Uses `inProgress > 0`, NOT `taskSummary.running` — the latter also counts
    // *pending* (planned-but-unstarted) todos, which would make this popover/
    // gate path disagree with the header/TabManager spinner (driven by
    // sessionDerivedState.hasOpenTasks, in_progress only). A session that ends
    // with unstarted todos is idle, and both paths must agree on that.
    const hasInProgressTask = taskSummary.inProgress > 0;
    const promptStatus: 'working' | 'ready' =
      mainTurnInFlight || activeAgents > 0 || hasInProgressTask ? 'working' : 'ready';
    // `busy` keeps its existing semantic (also folds in waitingFor) for
    // the install-gate's "wait for idle" path — a paused-on-permission
    // tab shouldn't be torn down mid-flight either.
    const busy = promptStatus === 'working' || waitingFor !== null;

    let status: TabStatusSummary['status'];
    if (hasError) status = 'error';
    else if (sessionStarted) status = busy ? 'busy' : 'idle';
    else if (isStarting) status = 'starting';
    else status = 'not-started';

    return {
      tabId,
      title,
      projectPath,
      sessionId,
      sessionStarted,
      busy,
      promptStatus,
      mainTurnInFlight,
      activeAgents,
      tasks: {
        total: taskSummary.total,
        completed: taskSummary.done,
        inFlight: taskSummary.running,
      },
      contextUsage: contextUsage
        ? {
            totalTokens: contextUsage.totalTokens,
            maxTokens: contextUsage.maxTokens,
            percentage: contextUsage.percentage,
          }
        : null,
      branch,
      filesChanged,
      filesUntracked,
      status,
      waitingFor,
      updatedAt: Date.now(),
    };
  }, [
    tabId,
    title,
    projectPath,
    sessionId,
    sessionStarted,
    isStarting,
    hasError,
    messages,
    subagents,
    contextUsage,
    branch,
    filesChanged,
    filesUntracked,
    pendingPermission,
  ]);

  useEffect(() => {
    void api.publishTabStatus(summary).catch(() => {
      // Failure is non-fatal — popover will catch up on next publish.
    });
  }, [summary]);

  useEffect(() => {
    return () => {
      void api.removeTabStatus(tabId).catch(() => {});
    };
  }, [tabId]);
}
