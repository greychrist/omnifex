// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the transport BEFORE importing api.ts. Every api method runs
// through this single function, so we only need one mock to drive every
// test path.
const apiCallMock = vi.fn();
vi.mock('../apiAdapter', () => ({
  apiCall: (...args: unknown[]) => apiCallMock(...args),
}));

import { api } from '../api';

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  apiCallMock.mockReset();
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe('api — channel + params mapping (table-driven)', () => {
  // Each row: [label, () => api.method(...args), expectedChannel, expectedParams]
  // The mock returns a sentinel; we assert the channel/params shape, not the
  // return value (each method's payload-shape is the type-checker's job).
  const cases: {
    label: string;
    call: () => Promise<unknown>;
    channel: string;
    params: unknown;
  }[] = [
    { label: 'listProjects', call: () => api.listProjects(), channel: 'list_projects', params: undefined },
    { label: 'createProject', call: () => api.createProject('/p'), channel: 'create_project', params: { path: '/p' } },
    {
      label: 'getProjectSessions w/o projectPath',
      call: () => api.getProjectSessions('p1'),
      channel: 'get_project_sessions',
      params: { projectId: 'p1' },
    },
    {
      label: 'getProjectSessions w/ projectPath',
      call: () => api.getProjectSessions('p1', '/repos/x'),
      channel: 'get_project_sessions',
      params: { projectId: 'p1', projectPath: '/repos/x' },
    },
    {
      label: 'deleteSession w/o projectPath',
      call: () => api.deleteSession('s1', 'p1'),
      channel: 'delete_session',
      params: { sessionId: 's1', projectId: 'p1' },
    },
    {
      label: 'deleteClaudeProject',
      call: () => api.deleteClaudeProject({ accountId: 5, projectId: 'p1' }),
      channel: 'delete_project',
      params: { accountId: 5, projectId: 'p1' },
    },
    {
      label: 'getSystemPrompt',
      call: () => api.getSystemPrompt(),
      channel: 'get_system_prompt',
      params: undefined,
    },
    {
      label: 'checkClaudeVersion',
      call: () => api.checkClaudeVersion(),
      channel: 'check_claude_version',
      params: undefined,
    },
    {
      label: 'findClaudeMdFiles',
      call: () => api.findClaudeMdFiles('/p'),
      channel: 'find_claude_md_files',
      params: { projectPath: '/p' },
    },
    {
      label: 'readClaudeMdFile',
      call: () => api.readClaudeMdFile('/p/CLAUDE.md'),
      channel: 'read_claude_md_file',
      params: { filePath: '/p/CLAUDE.md' },
    },
    {
      label: 'saveClaudeMdFile',
      call: () => api.saveClaudeMdFile('/p/CLAUDE.md', 'content'),
      channel: 'save_claude_md_file',
      params: { filePath: '/p/CLAUDE.md', content: 'content' },
    },
    {
      label: 'sendMessage',
      call: () => api.sendMessage('tab-1', 'hello'),
      channel: 'session_send_message',
      params: { tabId: 'tab-1', prompt: 'hello' },
    },
    {
      label: 'sendStructuredMessage',
      call: () => api.sendStructuredMessage('tab-1', [{ type: 'text', text: 'hi' }]),
      channel: 'session_send_structured_message',
      params: { tabId: 'tab-1', content: [{ type: 'text', text: 'hi' }] },
    },
    {
      label: 'stopSession',
      call: () => api.stopSession('tab-1'),
      channel: 'session_stop',
      params: { tabId: 'tab-1' },
    },
    {
      label: 'sessionRebind',
      call: () => api.sessionRebind('tab-1'),
      channel: 'session_rebind',
      params: { tabId: 'tab-1' },
    },
    {
      // Pre-Codex callers omit the agent param entirely; main process
      // defaults to 'claude'. Verify the wrapper forwards `undefined`
      // (not 'claude') so the default lives in exactly one place — the
      // backend. Layering defaults on both sides drifts inevitably.
      label: 'startSession without agent → forwards undefined',
      call: () => api.startSession('tab-1', '/p', 'sonnet', 'default'),
      channel: 'session_start',
      params: {
        tabId: 'tab-1', projectPath: '/p', model: 'sonnet', permissionMode: 'default',
        resumeSessionId: undefined, configDir: undefined, effort: undefined,
        thinking: undefined, mode: undefined, manualAccountOverride: undefined,
        agent: undefined,
      },
    },
    {
      label: 'startSession with agent="codex" → forwards literal',
      call: () =>
        api.startSession(
          'tab-1', '/p', 'sonnet', 'default',
          undefined, '/cfg', 'medium',
          { type: 'adaptive' }, 'rich', false, 'codex',
        ),
      channel: 'session_start',
      params: {
        tabId: 'tab-1', projectPath: '/p', model: 'sonnet', permissionMode: 'default',
        resumeSessionId: undefined, configDir: '/cfg', effort: 'medium',
        thinking: { type: 'adaptive' }, mode: 'rich', manualAccountOverride: false,
        agent: 'codex',
      },
    },
    {
      label: 'sessionGetHealth',
      call: () => api.sessionGetHealth('tab-1'),
      channel: 'session_get_health',
      params: { tabId: 'tab-1' },
    },
    {
      label: 'sessionInterrupt',
      call: () => api.sessionInterrupt('tab-1'),
      channel: 'session_interrupt',
      params: { tabId: 'tab-1' },
    },
    {
      label: 'sessionSetModel',
      call: () => api.sessionSetModel('tab-1', 'sonnet'),
      channel: 'session_set_model',
      params: { tabId: 'tab-1', model: 'sonnet' },
    },
    {
      label: 'sessionSetPermissionMode',
      call: () => api.sessionSetPermissionMode('tab-1', 'default'),
      channel: 'session_set_permission_mode',
      params: { tabId: 'tab-1', mode: 'default' },
    },
    {
      label: 'logWriteBatch',
      call: () => api.logWriteBatch([]),
      channel: 'log_write_batch',
      params: { entries: [] },
    },
    {
      label: 'logCount with undefined filters',
      call: () => api.logCount(),
      channel: 'log_count',
      params: {
        levels: undefined,
        sources: undefined,
        search: undefined,
        since: undefined,
        until: undefined,
      },
    },
    {
      label: 'listDirectoryContents',
      call: () => api.listDirectoryContents('/x'),
      channel: 'list_directory_contents',
      params: { directoryPath: '/x' },
    },
    {
      label: 'searchFiles',
      call: () => api.searchFiles('/x', 'q'),
      channel: 'search_files',
      params: { basePath: '/x', query: 'q' },
    },
    {
      label: 'getUsageByDateRange',
      call: () => api.getUsageByDateRange('2026-01-01', '2026-02-01'),
      channel: 'get_usage_by_date_range',
      params: { startDate: '2026-01-01', endDate: '2026-02-01' },
    },
    {
      label: 'getSessionStats with order',
      call: () => api.getSessionStats('20260101', '20260201', 'desc'),
      channel: 'get_session_stats',
      params: { since: '20260101', until: '20260201', order: 'desc' },
    },
  ];

  for (const { label, call, channel, params } of cases) {
    it(`${label} → ${channel}`, async () => {
      apiCallMock.mockResolvedValue('ok');
      await call();
      expect(apiCallMock).toHaveBeenCalledTimes(1);
      // Some api methods call apiCall(channel) with a single arg when no
      // params are needed; the table marks those rows with params=undefined.
      // Match flexibly so we don't assert on arity vs presence-of-undefined.
      const callArgs = apiCallMock.mock.calls[0];
      expect(callArgs[0]).toBe(channel);
      if (params === undefined) {
        expect(callArgs[1]).toBeUndefined();
      } else {
        expect(callArgs[1]).toEqual(params);
      }
    });
  }
});

describe('api — error-fallback paths', () => {
  it('getHomeDirectory swallows errors and falls back to "/"', async () => {
    apiCallMock.mockRejectedValue(new Error('boom'));
    const result = await api.getHomeDirectory();
    expect(result).toBe('/');
  });

  it('listProjects re-throws errors (no fallback)', async () => {
    apiCallMock.mockRejectedValue(new Error('boom'));
    await expect(api.listProjects()).rejects.toThrow('boom');
  });

  it('createProject re-throws errors after logging', async () => {
    apiCallMock.mockRejectedValue(new Error('cant create'));
    await expect(api.createProject('/p')).rejects.toThrow('cant create');
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('getUsageStats re-throws errors after logging', async () => {
    apiCallMock.mockRejectedValue(new Error('usage fail'));
    await expect(api.getUsageStats()).rejects.toThrow('usage fail');
  });
});

describe('api — optional-param assembly', () => {
  it('getClaudeSettings includes only the projectPath/configDir keys that were passed', async () => {
    apiCallMock.mockResolvedValue({});
    await api.getClaudeSettings({ projectPath: '/p' });
    expect(apiCallMock).toHaveBeenLastCalledWith(
      'get_claude_settings',
      expect.objectContaining({ projectPath: '/p' }),
    );

    await api.getClaudeSettings({ configDir: '/c' });
    expect(apiCallMock).toHaveBeenLastCalledWith(
      'get_claude_settings',
      expect.objectContaining({ configDir: '/c' }),
    );

    await api.getClaudeSettings();
    // Default: empty params object (no projectPath / configDir keys assigned).
    const [, params] = apiCallMock.mock.calls[apiCallMock.mock.calls.length - 1];
    expect(params).toEqual({});
  });

  it('deleteSession omits projectPath when undefined and includes it when present', async () => {
    apiCallMock.mockResolvedValue(undefined);
    await api.deleteSession('s', 'p');
    expect(apiCallMock).toHaveBeenLastCalledWith('delete_session', { sessionId: 's', projectId: 'p' });
    await api.deleteSession('s', 'p', '/path');
    expect(apiCallMock).toHaveBeenLastCalledWith('delete_session', {
      sessionId: 's', projectId: 'p', projectPath: '/path',
    });
  });
});
