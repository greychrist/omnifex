// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { Session, SessionSummary } from '@/lib/api';

// framer-motion is deliberately NOT mocked: a `require('react')` mock resolves
// Vite's CJS copy, a second React, and state in that subtree never updates.

// Frozen, so the stub returns the SAME reference every render; otherwise the
// `[projectPath, accounts]` effect re-fires and exhausts mockResolvedValueOnce.
const STUB_ACCOUNTS: readonly never[] = Object.freeze([]);
vi.mock('@/contexts/AccountsContext', () => ({
  useAccounts: () => ({
    accounts: STUB_ACCOUNTS,
    refresh: async () => {},
    getColor: () => null,
    getIcon: () => null,
    getAccountType: () => null,
  }),
}));

const generatingCallbackRef: { current: ((p: { sessionUuid: string; generating: boolean }) => void) | null } = { current: null };

vi.mock('@/lib/api', async () => {
  return {
    api: {
      summaryGet: vi.fn(),
      summaryGenerate: vi.fn(),
      onSessionSummaryUpdated: vi.fn(() => () => {}),
      onSessionSummaryGenerating: vi.fn((cb: (p: { sessionUuid: string; generating: boolean }) => void) => {
        generatingCallbackRef.current = cb;
        return () => {
          generatingCallbackRef.current = null;
        };
      }),
      getGeneratingSummaryUuids: vi.fn(async () => [] as string[]),
      resolveAccountForProject: vi.fn(),
      getSetting: vi.fn(async (key: string) => {
        if (key === 'sessionsSummary.enabled') return 'true';
        return null;
      }),
      listCodexSessions: vi.fn(async () => [] as {
        conversationId: string;
        projectPath: string | null;
        lastActivity: string;
        jsonlPath: string;
      }[]),
      sessionCostSessions: vi.fn(async () => [] as {
        session_id: string;
        account_name: string;
        project_path: string | null;
        first_date: string;
        last_date: string;
        cost_usd: number;
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_write_tokens: number;
      }[]),
    },
    PROMPT_TEMPLATE_SETTING_KEY: 'sessionsSummary.promptTemplate',
    ENABLED_SETTING_KEY: 'sessionsSummary.enabled',
  };
});

import { api } from '@/lib/api';
import { SessionList } from '../SessionList';

const sessionFixture: Session = {
  id: 'sess-1',
  first_timestamp: '2026-05-05T10:00:00Z',
  last_timestamp: '2026-05-05T11:00:00Z',
  created_at: 1714900000,
} as Session;

const summaryFixture: SessionSummary = {
  version: 1,
  headline: 'Summary headline here.',
  paragraph: 'Summary paragraph here, with details.',
  messageCount: 7,
  jsonlSize: 4096,
  generatedAt: '2026-05-05T11:05:00Z',
  model: 'claude-haiku-4-5',
  accountName: 'Test',
};

const isSpinning = (btn: HTMLElement): boolean =>
  !!btn.querySelector('.animate-spin');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.summaryGet).mockResolvedValue(summaryFixture);
  vi.mocked(api.summaryGenerate).mockResolvedValue({
    status: 'generated',
    summary: {
      ...summaryFixture,
      headline: 'Refreshed headline.',
      paragraph: 'Refreshed paragraph.',
    },
  });
  vi.mocked(api.resolveAccountForProject).mockResolvedValue({
    claude: {
      account: {
        id: 1,
        name: 'Test',
        config_dir: '/x/.claude',
        engine: 'claude',
        subscription_label: 'pro',
        has_cost: true,
        color: null,
        icon: null,
        cli_path: null,
        expected_email: null,
        created_at: '',
        updated_at: '',
        summaryModel: 'haiku',
      },
      matchType: 'path_rule',
      matchDetail: '/x',
    },
    codex: null,
  });

  vi.mocked(api.getSetting).mockImplementation(async (key: string) => {
    if (key === 'sessionsSummary.enabled') return 'true';
    return null;
  });
});

// floating-ui measures through ResizeObserver, absent in jsdom, so tooltip
// content would never mount.
beforeAll(() => {
  class StubResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = StubResizeObserver;
});

afterEach(() => { cleanup(); });

describe('SessionList summary rendering', () => {
  it('renders the summary headline collapsed by default and reveals the paragraph on chevron click', async () => {
    render(<SessionList sessions={[sessionFixture]} projectPath="/x" />);

    expect(await screen.findByText('Summary headline here.')).toBeTruthy();

    expect(screen.queryByText('Summary paragraph here, with details.')).toBeNull();

    const expandBtn = screen.getByRole('button', { name: /expand summary/i });
    fireEvent.click(expandBtn);
    expect(screen.getByText('Summary paragraph here, with details.')).toBeTruthy();

    const collapseBtn = screen.getByRole('button', { name: /collapse summary/i });
    fireEvent.click(collapseBtn);
    expect(screen.queryByText('Summary paragraph here, with details.')).toBeNull();
  });

  it('renders every session with no pagination controls (relies on the bounded-scroll container instead)', async () => {
    const many: Session[] = Array.from({ length: 30 }, (_, i) => ({
      ...sessionFixture,
      id: `sess-${i + 1}`,
    }));
    vi.mocked(api.summaryGet).mockResolvedValue(null);

    render(<SessionList sessions={many} projectPath="/x" />);

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /delete session/i })).toHaveLength(30);
    });

    expect(screen.queryByRole('button', { name: /previous|next|page/i })).toBeNull();
  });

  it('expands rows independently — toggling one does not affect another', async () => {
    const sess2: Session = { ...sessionFixture, id: 'sess-2' };
    vi.mocked(api.summaryGet).mockImplementation(async (sessionUuid: string) => {
      if (sessionUuid === 'sess-2') {
        return {
          ...summaryFixture,
          headline: 'Second headline.',
          paragraph: 'Second paragraph body.',
        };
      }
      return summaryFixture;
    });

    render(<SessionList sessions={[sessionFixture, sess2]} projectPath="/x" />);
    await screen.findByText('Summary headline here.');
    await screen.findByText('Second headline.');

    const expandBtns = screen.getAllByRole('button', { name: /expand summary/i });
    expect(expandBtns).toHaveLength(2);

    fireEvent.click(expandBtns[0]);
    expect(screen.getByText('Summary paragraph here, with details.')).toBeTruthy();
    expect(screen.queryByText('Second paragraph body.')).toBeNull();
  });

  it('shows "No name" — never the first prompt — when there is no title and no summary', async () => {
    vi.mocked(api.summaryGet).mockResolvedValueOnce(null);
    render(<SessionList sessions={[sessionFixture]} projectPath="/x" />);
    expect(await screen.findByText('No name')).toBeTruthy();
  });

  describe('ai_title', () => {
    const titled: Session = { ...sessionFixture, ai_title: 'Duplicate user prompt' };

    it('labels the row with the CLI title when there is no sidecar summary', async () => {
      vi.mocked(api.summaryGet).mockResolvedValueOnce(null);
      render(<SessionList sessions={[titled]} projectPath="/x" />);
      expect(await screen.findByText('Duplicate user prompt')).toBeTruthy();
    });

    it('shows nothing underneath the title when there is no summary', async () => {
      vi.mocked(api.summaryGet).mockResolvedValueOnce(null);
      render(<SessionList sessions={[titled]} projectPath="/x" />);
      await screen.findByText('Duplicate user prompt');
      expect(screen.queryByText('No name')).toBeNull();
    });

    // Await the SUMMARY first: summaryGet is async, so the title-only branch
    // renders before it lands.
    it('keeps the title as the label and puts the summary beneath it', async () => {
      render(<SessionList sessions={[titled]} projectPath="/x" />);
      await screen.findByText('Summary headline here.');
      expect(screen.getByText('Duplicate user prompt')).toBeTruthy();
    });


    it('still expands to the full summary paragraph under a title', async () => {
      render(<SessionList sessions={[titled]} projectPath="/x" />);
      await screen.findByText('Summary headline here.');
      expect(screen.getByText('Duplicate user prompt')).toBeTruthy();
      expect(screen.queryByText('Summary paragraph here, with details.')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /expand summary/i }));
      expect(screen.getByText('Summary paragraph here, with details.')).toBeTruthy();
    });

    it('leaves the untitled row exactly as it was — summary headline is the label', async () => {
      render(<SessionList sessions={[sessionFixture]} projectPath="/x" />);
      expect(await screen.findByText('Summary headline here.')).toBeTruthy();
    });

    it('shows "No name" when the CLI never titled the session and there is no summary', async () => {
      vi.mocked(api.summaryGet).mockResolvedValueOnce(null);
      render(<SessionList sessions={[sessionFixture]} projectPath="/x" />);
      expect(await screen.findByText('No name')).toBeTruthy();
    });

    it('prefers a rename over the CLI’s generated title', async () => {
      const renamed: Session = { ...titled, custom_title: 'Rate-limit spike' };
      vi.mocked(api.summaryGet).mockResolvedValueOnce(null);
      render(<SessionList sessions={[renamed]} projectPath="/x" />);
      expect(await screen.findByText('Rate-limit spike')).toBeTruthy();
      expect(screen.queryByText('Duplicate user prompt')).toBeNull();
    });

    it('labels a renamed session that the CLI never titled', async () => {
      const renamed: Session = { ...sessionFixture, custom_title: 'Rate-limit spike' };
      vi.mocked(api.summaryGet).mockResolvedValueOnce(null);
      render(<SessionList sessions={[renamed]} projectPath="/x" />);
      expect(await screen.findByText('Rate-limit spike')).toBeTruthy();
    });
  });

  describe('icon tooltips', () => {
    const tipFor = (trigger: HTMLElement): string => {
      const id = trigger.getAttribute('aria-describedby');
      return id ? (document.getElementById(id)?.textContent ?? '') : '';
    };

    const focusAndRead = async (trigger: HTMLElement): Promise<string> => {
      fireEvent.focus(trigger);
      await waitFor(() => {
        expect(trigger.getAttribute('aria-describedby')).toBeTruthy();
      });
      return tipFor(trigger);
    };

    it('describes the launch icon on focus instead of relying on a title attribute', async () => {
      render(<SessionList sessions={[sessionFixture]} projectPath="/x" />);
      const launch = (await screen.findAllByRole('button', { name: /launch session/i }))[0];
      expect(launch.getAttribute('title')).toBeNull();
      expect(await focusAndRead(launch)).toMatch(/launch session/i);
    });

    it('describes the delete icon', async () => {
      render(<SessionList sessions={[sessionFixture]} projectPath="/x" />);
      const del = await screen.findByRole('button', { name: /delete session/i });
      expect(await focusAndRead(del)).toMatch(/delete session/i);
    });

    it('describes the copy-id control with the full session id', async () => {
      render(<SessionList sessions={[sessionFixture]} projectPath="/x" />);
      const copy = await screen.findByRole('button', { name: /copy session id/i });
      expect(await focusAndRead(copy)).toContain('sess-1');
    });

    it('still explains why the summary button is disabled', async () => {
      const unchanged: Session = { ...sessionFixture, file_size_bytes: 4096 };
      render(<SessionList sessions={[unchanged]} projectPath="/x" />);
      const btn = await screen.findByRole('button', { name: /refresh summary/i });
      expect(await focusAndRead(btn)).toMatch(/no new messages/i);
    });
  });

  it('clicking refresh calls summaryGenerate and updates the row on success', async () => {
    const sessionWithDifferentSize: Session = {
      ...sessionFixture,
      file_size_bytes: 9999, // Differs from summary.jsonlSize (4096)
    };
    render(<SessionList sessions={[sessionWithDifferentSize]} projectPath="/x" />);
    await screen.findByText('Summary headline here.');
    fireEvent.click(screen.getByRole('button', { name: /refresh summary/i }));
    await waitFor(
      () => { expect(screen.getByText('Refreshed headline.')).toBeTruthy(); },
      { timeout: 2000 },
    );
  });

  it('shows a friendly inline message when generation is skipped (toggle-off)', async () => {
    vi.mocked(api.summaryGenerate).mockResolvedValueOnce({
      status: 'skipped',
      reason: 'toggle-off',
    });
    const sessionWithDifferentSize: Session = {
      ...sessionFixture,
      file_size_bytes: 9999,
    };
    render(<SessionList sessions={[sessionWithDifferentSize]} projectPath="/x" />);
    await screen.findByText('Summary headline here.');
    fireEvent.click(screen.getByRole('button', { name: /refresh summary/i }));
    await waitFor(
      () =>
        { expect(
          screen.getByText(/Summaries are off for this account/i),
        ).toBeTruthy(); },
      { timeout: 2000 },
    );
  });

  it('shows a friendly inline message when generation is skipped (no-model)', async () => {
    vi.mocked(api.summaryGenerate).mockResolvedValueOnce({
      status: 'skipped',
      reason: 'no-model',
    });
    const sessionWithDifferentSize: Session = {
      ...sessionFixture,
      file_size_bytes: 9999,
    };
    render(<SessionList sessions={[sessionWithDifferentSize]} projectPath="/x" />);
    await screen.findByText('Summary headline here.');
    fireEvent.click(screen.getByRole('button', { name: /refresh summary/i }));
    await waitFor(
      () =>
        { expect(
          screen.getByText(/No summary model selected/i),
        ).toBeTruthy(); },
      { timeout: 2000 },
    );
  });

  it('hides the summary and refresh icon when the MASTER "enabled" toggle is off', async () => {
    vi.mocked(api.getSetting).mockImplementation(async (key: string) => {
      if (key === 'sessionsSummary.enabled') return 'false';
      return null;
    });
    render(<SessionList sessions={[sessionFixture]} projectPath="/x" />);
    // summaryGet's mock can land before or after resolveAccountForProject's.
    await waitFor(() => {
      expect(api.summaryGet).toHaveBeenCalled();
      expect(api.resolveAccountForProject).toHaveBeenCalled();
      expect(screen.queryByText('No name')).not.toBeNull();
      expect(screen.queryByText('Summary headline here.')).toBeNull();
    });
    expect(screen.queryByRole('button', { name: /refresh summary/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /generate summary/i })).toBeNull();
  });

  it('hides the summary and refresh icon when the resolved account has no model selected', async () => {
    vi.mocked(api.resolveAccountForProject).mockResolvedValueOnce({
      claude: {
        account: {
          id: 1,
          name: 'Test',
          config_dir: '/x/.claude',
          engine: 'claude',
          subscription_label: 'pro',
          has_cost: true,
          color: null,
          icon: null,
          cli_path: null,
          expected_email: null,
          created_at: '',
          updated_at: '',
          summarizeOnClose: true,
          summaryModel: null, // no model
        },
        matchType: 'path_rule',
        matchDetail: '/x',
      },
      codex: null,
    });
    render(<SessionList sessions={[sessionFixture]} projectPath="/x" />);
    await waitFor(() => {
      expect(api.summaryGet).toHaveBeenCalled();
      expect(api.resolveAccountForProject).toHaveBeenCalled();
      expect(screen.queryByText('No name')).not.toBeNull();
      expect(screen.queryByText('Summary headline here.')).toBeNull();
    });
    expect(screen.queryByRole('button', { name: /refresh summary/i })).toBeNull();
  });

  it('disables the refresh button when JSONL size matches cached summary', async () => {
    const sessionWithSameSize: Session = {
      ...sessionFixture,
      file_size_bytes: 4096, // Matches summary.jsonlSize
    };
    render(<SessionList sessions={[sessionWithSameSize]} projectPath="/x" />);
    await screen.findByText('Summary headline here.');
    const btn = screen.getByRole('button', { name: /refresh summary/i });
    expect(btn.hasAttribute('disabled')).toBe(true);
  });

  it('spins the refresh icon when a backend "generating: true" event arrives, and stops on "generating: false"', async () => {
    // The spinning glyph is the signal; tooltip prose exists only while open.
    const sessionWithDifferentSize: Session = {
      ...sessionFixture,
      file_size_bytes: 9999,
    };
    render(<SessionList sessions={[sessionWithDifferentSize]} projectPath="/x" />);
    const btn = await screen.findByRole('button', { name: /refresh summary/i });
    expect(isSpinning(btn)).toBe(false);

    expect(generatingCallbackRef.current).not.toBeNull();
    generatingCallbackRef.current!({
      sessionUuid: sessionFixture.id,
      generating: true,
    });
    await waitFor(() => {
      expect(
        isSpinning(screen.getByRole('button', { name: /refresh summary/i })),
      ).toBe(true);
    });

    generatingCallbackRef.current!({
      sessionUuid: sessionFixture.id,
      generating: false,
    });
    await waitFor(() => {
      expect(
        isSpinning(screen.getByRole('button', { name: /refresh summary/i })),
      ).toBe(false);
    });
  });

  it('seeds the spinner on mount from getGeneratingSummaryUuids (back-button race fix)', async () => {
    // The lifecycle hook can fire `generating: true` before SessionList
    // subscribes: back-button close and navigation happen in one frame.
    vi.mocked(api.getGeneratingSummaryUuids).mockResolvedValueOnce([sessionFixture.id]);
    const sessionWithDifferentSize: Session = {
      ...sessionFixture,
      file_size_bytes: 9999,
    };
    render(<SessionList sessions={[sessionWithDifferentSize]} projectPath="/x" />);
    await screen.findByText('Summary headline here.');
    await waitFor(() => {
      expect(
        isSpinning(screen.getByRole('button', { name: /refresh summary/i })),
      ).toBe(true);
    });
  });

  it('ignores "generating" events for session ids not in the current list', async () => {
    const sessionWithDifferentSize: Session = {
      ...sessionFixture,
      file_size_bytes: 9999,
    };
    render(<SessionList sessions={[sessionWithDifferentSize]} projectPath="/x" />);
    const btn = await screen.findByRole('button', { name: /refresh summary/i });
    expect(isSpinning(btn)).toBe(false);

    expect(generatingCallbackRef.current).not.toBeNull();
    generatingCallbackRef.current!({
      sessionUuid: 'some-other-session',
      generating: true,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(
      isSpinning(screen.getByRole('button', { name: /refresh summary/i })),
    ).toBe(false);
  });
});

describe('SessionList — click semantics', () => {
  it('does NOT fire onSessionClick when the user clicks Summary or Session ID cell chrome', async () => {
    const onSessionClick = vi.fn();
    vi.mocked(api.summaryGet).mockResolvedValue(null);
    const { container } = render(
      <SessionList
        sessions={[sessionFixture]}
        projectPath="/x"
        onSessionClick={onSessionClick}
      />,
    );

    await screen.findByText('No name');

    // cells[0]=Date (launch), cells[1]=Summary, cells[2]=Session ID,
    // cells[3]=actions.
    const cells = Array.from(
      container.querySelectorAll('tbody tr td'),
    );
    expect(cells.length).toBeGreaterThanOrEqual(4);
    fireEvent.click(cells[1]);
    fireEvent.click(cells[2]);
    expect(onSessionClick).not.toHaveBeenCalled();
  });

  it('fires onSessionClick when the user clicks the Date cell (now a launch target)', async () => {
    const onSessionClick = vi.fn();
    render(
      <SessionList
        sessions={[sessionFixture]}
        projectPath="/x"
        onSessionClick={onSessionClick}
      />,
    );
    await screen.findByText('Summary headline here.');

    // Two launch buttons per row; only the date one's text contains "/".
    const launchButtons = screen.getAllByRole('button', { name: /launch session/i });
    const dateBtn = launchButtons.find((b) => /\d+\/\d+\/\d+/.test(b.textContent ?? ''));
    expect(dateBtn).toBeDefined();
    fireEvent.click(dateBtn!);
    expect(onSessionClick).toHaveBeenCalledTimes(1);
    expect(onSessionClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sess-1' }),
    );
  });

  it('fires onSessionClick when the user clicks the session name', async () => {
    const onSessionClick = vi.fn();
    render(
      <SessionList
        sessions={[sessionFixture]}
        projectPath="/x"
        onSessionClick={onSessionClick}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Summary headline here.' }));
    expect(onSessionClick).toHaveBeenCalledTimes(1);
    expect(onSessionClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sess-1' }),
    );
  });

  it('fires onSessionClick when an untitled, unsummarised row\'s "No name" is clicked', async () => {
    const onSessionClick = vi.fn();
    vi.mocked(api.summaryGet).mockResolvedValue(null);
    render(
      <SessionList
        sessions={[sessionFixture]}
        projectPath="/x"
        onSessionClick={onSessionClick}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'No name' }));
    expect(onSessionClick).toHaveBeenCalledTimes(1);
  });

  it('fires onSessionClick when the user clicks the rightmost launch icon (actions cluster)', async () => {
    const onSessionClick = vi.fn();
    render(
      <SessionList
        sessions={[sessionFixture]}
        projectPath="/x"
        onSessionClick={onSessionClick}
      />,
    );
    await screen.findByText('Summary headline here.');

    const launchButtons = screen.getAllByRole('button', { name: /launch session/i });
    const iconBtn = launchButtons.find((b) => !/\d+\/\d+\/\d+/.test(b.textContent ?? ''));
    expect(iconBtn).toBeDefined();
    fireEvent.click(iconBtn!);
    expect(onSessionClick).toHaveBeenCalledTimes(1);
    expect(onSessionClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sess-1' }),
    );
  });

  it('dispatches the claude-session-selected CustomEvent on launch', async () => {
    const listener = vi.fn();
    window.addEventListener('claude-session-selected', listener as EventListener);
    try {
      render(<SessionList sessions={[sessionFixture]} projectPath="/x" />);
      await screen.findByText('Summary headline here.');
      const launchButtons = screen.getAllByRole('button', { name: /launch session/i });
      const iconBtn = launchButtons.find((b) => !/\d+\/\d+\/\d+/.test(b.textContent ?? ''));
      fireEvent.click(iconBtn!);
      expect(listener).toHaveBeenCalledTimes(1);
      const evt = listener.mock.calls[0][0] as CustomEvent;
      expect((evt.detail).session.id).toBe('sess-1');
      expect((evt.detail).projectPath).toBe('/x');
    } finally {
      window.removeEventListener('claude-session-selected', listener as EventListener);
    }
  });

  it('clicking copy-ID, summary chevron, refresh, or trash never fires onSessionClick', async () => {
    const onSessionClick = vi.fn();
    const sessionWithDifferentSize: Session = {
      ...sessionFixture,
      file_size_bytes: 9999,
    };
    // jsdom has no navigator.clipboard.
    const originalClipboard = (navigator as any).clipboard;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    try {
      render(
        <SessionList
          sessions={[sessionWithDifferentSize]}
          projectPath="/x"
          onSessionClick={onSessionClick}
        />,
      );
      await screen.findByText('Summary headline here.');

      const copyBtn = screen.getByRole('button', { name: /copy session id/i });
      fireEvent.click(copyBtn);

      fireEvent.click(screen.getByRole('button', { name: /expand summary/i }));

      fireEvent.click(screen.getByRole('button', { name: /refresh summary/i }));

      fireEvent.click(screen.getByRole('button', { name: /delete session/i }));

      expect(onSessionClick).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: originalClipboard,
      });
    }
  });
});

describe('SessionList — Codex partition (Task 16)', () => {
  const codexEntry = {
    conversationId: '019cb5ad-0c36-7d80-b43f-559e40646c80',
    projectPath: '/x',
    lastActivity: '2026-05-10T12:00:00Z',
    jsonlPath:
      '/Users/test/.codex/sessions/2026/05/10/rollout-2026-05-10T12-00-00-019cb5ad-0c36-7d80-b43f-559e40646c80.jsonl',
  };
  const codexEntryOtherProject = {
    conversationId: '019d1c78-c93c-7e10-807d-43a194215440',
    projectPath: '/other/project',
    lastActivity: '2026-05-09T12:00:00Z',
    jsonlPath:
      '/Users/test/.codex/sessions/2026/05/09/rollout-019d1c78-c93c-7e10-807d-43a194215440.jsonl',
  };

  it('renders a Codex row with engine icon when api.listCodexSessions returns an entry under this project', async () => {
    vi.mocked(api.listCodexSessions).mockResolvedValueOnce([codexEntry]);
    vi.mocked(api.summaryGet).mockResolvedValue(null);
    render(<SessionList sessions={[]} projectPath="/x" />);
    expect(await screen.findByLabelText('Codex session')).toBeTruthy();
    expect(screen.getByText(codexEntry.conversationId.slice(0, 8))).toBeTruthy();
  });

  it('filters Codex entries whose projectPath does NOT match the current project', async () => {
    vi.mocked(api.listCodexSessions).mockResolvedValueOnce([
      codexEntry,
      codexEntryOtherProject,
    ]);
    vi.mocked(api.summaryGet).mockResolvedValue(null);
    render(<SessionList sessions={[]} projectPath="/x" />);
    await screen.findByText(codexEntry.conversationId.slice(0, 8));
    expect(
      screen.queryByText(codexEntryOtherProject.conversationId.slice(0, 8)),
    ).toBeNull();
  });

  it('hides Codex rows when the agent filter is set to "claude"', async () => {
    vi.mocked(api.listCodexSessions).mockResolvedValueOnce([codexEntry]);
    vi.mocked(api.summaryGet).mockResolvedValue(null);
    render(
      <SessionList sessions={[sessionFixture]} projectPath="/x" />,
    );
    // Both rows must be visible before the filter flips.
    await screen.findByText(codexEntry.conversationId.slice(0, 8));
    expect(screen.getByText(/sess-1/)).toBeTruthy();

    // The filter renders only when both engines have rows.
    const claudeFilter = screen
      .getAllByRole('button', { pressed: false })
      .find((b) => /^claude$/i.test(b.textContent ?? ''));
    expect(claudeFilter).toBeDefined();
    fireEvent.click(claudeFilter!);

    expect(
      screen.queryByText(codexEntry.conversationId.slice(0, 8)),
    ).toBeNull();
    expect(screen.getByText(/sess-1/)).toBeTruthy();
  });

  it('dispatches codex-session-selected CustomEvent on Codex row click', async () => {
    vi.mocked(api.listCodexSessions).mockResolvedValueOnce([codexEntry]);
    vi.mocked(api.summaryGet).mockResolvedValue(null);
    const listener = vi.fn();
    window.addEventListener('codex-session-selected', listener as EventListener);
    try {
      render(<SessionList sessions={[]} projectPath="/x" />);
      await screen.findByText(codexEntry.conversationId.slice(0, 8));

      const launchBtns = screen.getAllByRole('button', {
        name: /launch codex session/i,
      });
      expect(launchBtns.length).toBeGreaterThanOrEqual(1);
      fireEvent.click(launchBtns[0]);
      expect(listener).toHaveBeenCalledTimes(1);
      const evt = listener.mock.calls[0][0] as CustomEvent;
      expect((evt.detail).conversationId).toBe(codexEntry.conversationId);
      expect((evt.detail).projectPath).toBe('/x');
    } finally {
      window.removeEventListener(
        'codex-session-selected',
        listener as EventListener,
      );
    }
  });
});

describe('SessionList cost column + agent icon', () => {
  const costRow = {
    session_id: 'sess-1',
    account_name: 'Test',
    project_path: '/x',
    first_date: '2026-05-05',
    last_date: '2026-05-05',
    cost_usd: 1.1276,
    input_tokens: 1,
    output_tokens: 2,
    cache_read_tokens: 3,
    cache_write_tokens: 4,
  };

  it('renders a merged Size / Cost column header', async () => {
    render(<SessionList sessions={[sessionFixture]} projectPath="/x" />);
    await screen.findByText('No name');
    expect(screen.getByText('Size / Cost')).toBeTruthy();
  });

  it('shows the per-session cost fetched for the project path', async () => {
    vi.mocked(api.sessionCostSessions).mockResolvedValueOnce([costRow]);
    render(<SessionList sessions={[sessionFixture]} projectPath="/x" />);
    // 1.1276 formats to two decimals ($1.13) via the shared formatter.
    expect(await screen.findByText('$1.13')).toBeTruthy();
    expect(vi.mocked(api.sessionCostSessions)).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: '/x' }),
    );
  });

  it('shows an em-dash when no cost row exists for a session', async () => {
    vi.mocked(api.sessionCostSessions).mockResolvedValueOnce([]);
    render(<SessionList sessions={[sessionFixture]} projectPath="/x" />);
    await screen.findByText('No name');
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
  });

  it('no longer renders a standalone "Claude" agent-type label, but keeps the icon', async () => {
    render(<SessionList sessions={[sessionFixture]} projectPath="/x" />);
    await screen.findByText('No name');
    expect(screen.queryByText('Claude', { exact: true })).toBeNull();
    expect(screen.getAllByLabelText('Claude session').length).toBeGreaterThanOrEqual(1);
  });
});

