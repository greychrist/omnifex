import { useEffect, useMemo } from 'react';
import { api, type SessionContextUsage, type TabStatusSummary } from '@/lib/api';
import type { ClaudeStreamMessage } from '@/types/claudeStream';
import type { Subagent } from '@/lib/subagentStreams';
import { getLatestTodos, summarizeTodos } from '@/lib/latestTodos';

interface UsePublishTabStatusArgs {
  tabId: string;
  title: string;
  projectPath: string | null;
  sessionStarted: boolean;
  isStarting: boolean;
  /** True while a main-turn is in flight (parent-turn isLoading). */
  isLoading: boolean;
  hasError: boolean;
  messages: ClaudeStreamMessage[];
  /** Subagents already filtered through dismissals — same set the spinner sees. */
  subagents: Subagent[];
  contextUsage: SessionContextUsage | null;
  branch: string | null;
  filesChanged: number;
  filesUntracked: number;
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
  sessionStarted,
  isStarting,
  isLoading,
  hasError,
  messages,
  subagents,
  contextUsage,
  branch,
  filesChanged,
  filesUntracked,
}: UsePublishTabStatusArgs): void {
  const summary: TabStatusSummary = useMemo(() => {
    const todos = getLatestTodos(messages);
    const todoSummary = todos
      ? summarizeTodos(todos)
      : { done: 0, total: 0, running: false };
    const activeAgents = subagents.reduce(
      (n, s) => (s.status === 'running' ? n + 1 : n),
      0,
    );
    const mainTurnInFlight = isLoading;
    const busy = mainTurnInFlight || activeAgents > 0 || todoSummary.running;

    let status: TabStatusSummary['status'];
    if (hasError) status = 'error';
    else if (sessionStarted) status = busy ? 'busy' : 'idle';
    else if (isStarting) status = 'starting';
    else status = 'not-started';

    return {
      tabId,
      title,
      projectPath,
      sessionStarted,
      busy,
      mainTurnInFlight,
      activeAgents,
      todos: {
        total: todoSummary.total,
        completed: todoSummary.done,
        inFlight: todoSummary.running,
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
      updatedAt: Date.now(),
    };
  }, [
    tabId,
    title,
    projectPath,
    sessionStarted,
    isStarting,
    isLoading,
    hasError,
    messages,
    subagents,
    contextUsage,
    branch,
    filesChanged,
    filesUntracked,
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
