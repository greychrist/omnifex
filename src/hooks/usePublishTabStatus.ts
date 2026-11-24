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
  sessionId: string | null;
  sessionStarted: boolean;
  isStarting: boolean;
  turnRunning: boolean;
  hasError: boolean;
  messages: JsonlNode[];
  subagents: Subagent[];
  contextUsage: SessionContextUsage | null;
  branch: string | null;
  filesChanged: number;
  filesUntracked: number;
  pendingPermission: { toolName?: string } | null;
}

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
    // Never read off the transcript: a resumed session whose process died mid-turn ends open, and is idle.
    const mainTurnInFlight = turnRunning;
    const waitingFor = deriveWaitingFor(pendingPermission);
    // Excludes `waitingFor`: waiting on the user is ready, not working. `inProgress`, not `taskSummary.running`
    // (which counts pending todos), so this agrees with the hasOpenTasks spinner.
    const hasInProgressTask = taskSummary.inProgress > 0;
    const promptStatus: 'working' | 'ready' =
      mainTurnInFlight || activeAgents > 0 || hasInProgressTask ? 'working' : 'ready';
    // `busy` folds in waitingFor: the install gate must not tear down a tab paused on a permission.
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
    turnRunning,
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
      // Non-fatal: the next publish catches up.
    });
  }, [summary]);

  useEffect(() => {
    return () => {
      void api.removeTabStatus(tabId).catch(() => {});
    };
  }, [tabId]);
}
