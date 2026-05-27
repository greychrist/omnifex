// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { Session, SessionSummary } from '@/lib/api';

// Mock framer-motion to render its motion.tr as plain tr — avoids
// async-only assertions on real animation hooks.
vi.mock('framer-motion', () => ({
  motion: new Proxy(
    {},
    {
      get: (_, key) => {
        const Tag = key as string;
        return ({ children, ...rest }: any) => {
          // Strip animation-only props
          const { initial, animate, exit, transition, layout, ...domProps } = rest;
          void initial; void animate; void exit; void transition; void layout;

          // eslint-disable-next-line @typescript-eslint/no-require-imports -- vi.mock factory hoisted before module imports settle.
          return require('react').createElement(Tag, domProps, children);
        };
      },
    },
  ),
  AnimatePresence: ({ children }: any) => children,
}));

// SessionList consumes AccountsContext so it can re-trigger the
// per-project summary-resolution when account settings change. Tests
// mount it without a Provider; stub the hook so it returns an empty
// account list — that's enough to keep the resolution useEffect
// working off the test's `resolveAccountForProject` mock.
//
// Use a frozen array so the stub returns the SAME reference on every
// render — otherwise SessionList's `[projectPath, accounts]` effect
// re-fires on every re-render and exhausts the test's
// `mockResolvedValueOnce` after the first call.
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

// Tests can grab the registered `onSessionSummaryGenerating` callback
// off this ref and invoke it manually to simulate backend events.
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
      // Default: no in-flight generations on mount. Individual tests
      // override to seed the spinner via the mount-time query (covers
      // the back-button race where the lifecycle event fires before
      // the component has subscribed).
      getGeneratingSummaryUuids: vi.fn(async () => [] as string[]),
      resolveAccountForProject: vi.fn(),
      // The component reads two app_settings keys on mount: the prompt
      // template (returns null → prompt-hash compare is skipped) and the
      // master "enabled" toggle (returns 'true' → cached sidecars are
      // shown and the refresh icon is enabled). Individual tests can
      // override either via the keyed `mockImplementation` in beforeEach.
      getSetting: vi.fn(async (key: string) => {
        if (key === 'sessionsSummary.enabled') return 'true';
        return null;
      }),
      // Task 16 — Codex session walker. Default: no Codex rows. Codex-aware
      // tests below override this with mockResolvedValueOnce.
      listCodexSessions: vi.fn(async () => [] as Array<{
        conversationId: string;
        projectPath: string | null;
        lastActivity: string;
        jsonlPath: string;
      }>),
    },
    // Mirror the setting key constants the component imports.
    PROMPT_TEMPLATE_SETTING_KEY: 'sessionsSummary.promptTemplate',
    ENABLED_SETTING_KEY: 'sessionsSummary.enabled',
  };
});

// Tooltip provider + Pagination need real React; let them render normally.

import { api } from '@/lib/api';
import { SessionList } from '../SessionList';

const sessionFixture: Session = {
  id: 'sess-1',
  first_message: 'old first message preview',
  first_timestamp: '2026-05-05T10:00:00Z',
  last_timestamp: '2026-05-05T11:00:00Z',
  created_at: 1714900000,
  // Optional fields below — set to match the wider Session shape
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
  // Tests use getSetting → null, so the prompt-hash compare is skipped
  // and any (or no) promptHash on the fixture is fine.
};

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
  // Default: account has a summary model picked + global auto-on-close
  // is on (mocked above) → refresh icon renders. Individual tests can
  // override either by re-mocking before render.
  // Task 12 widened resolveAccountForProject to `{ agent, account }`;
  // the Claude account row now nests under `.account`.
  vi.mocked(api.resolveAccountForProject).mockResolvedValue({
    agent: 'claude',
    account: {
      id: 1,
      name: 'Test',
      config_dir: '/x/.claude',
      account_type: 'pro',
      color: null,
      icon: null,
      cli_path: null,
      created_at: '',
      updated_at: '',
      summaryModel: 'haiku',
    },
  });

  // Reset the keyed getSetting stub on every test so individual cases
  // can override one key without leaking into others.
  vi.mocked(api.getSetting).mockImplementation(async (key: string) => {
    if (key === 'sessionsSummary.enabled') return 'true';
    return null;
  });
});

afterEach(() => { cleanup(); });

describe('SessionList summary rendering', () => {
  it('renders the summary headline collapsed by default and reveals the paragraph on chevron click', async () => {
    render(<SessionList sessions={[sessionFixture]} projectPath="/x" />);

    // Headline is always visible.
    expect(await screen.findByText('Summary headline here.')).toBeTruthy();

    // Paragraph is hidden by default (collapsed state).
    expect(screen.queryByText('Summary paragraph here, with details.')).toBeNull();

    // Click the expand chevron — paragraph appears.
    const expandBtn = screen.getByRole('button', { name: /expand summary/i });
    fireEvent.click(expandBtn);
    expect(screen.getByText('Summary paragraph here, with details.')).toBeTruthy();

    // Now the chevron's role flips to "Collapse summary".
    const collapseBtn = screen.getByRole('button', { name: /collapse summary/i });
    fireEvent.click(collapseBtn);
    expect(screen.queryByText('Summary paragraph here, with details.')).toBeNull();
  });

  it('renders every session with no pagination controls (relies on the bounded-scroll container instead)', async () => {
    // Build 30 sessions — well past the old 12-per-page cap. Every one
    // should render; no Previous/Next/page-N controls should exist.
    const many: Session[] = Array.from({ length: 30 }, (_, i) => ({
      ...sessionFixture,
      id: `sess-${i + 1}`,
    }));
    vi.mocked(api.summaryGet).mockResolvedValue(null);

    render(<SessionList sessions={many} projectPath="/x" />);

    await waitFor(() => {
      // Each row exposes its session id as the copy-button label
      // ("sess-N" → first 8 chars displayed). Easier to count the
      // delete buttons since there's exactly one per row regardless
      // of summary state.
      expect(screen.getAllByRole('button', { name: /delete session/i })).toHaveLength(30);
    });

    // No pagination controls — neither prev/next nor numbered page buttons.
    expect(screen.queryByRole('button', { name: /previous|next|page/i })).toBeNull();
  });

  it('expands rows independently — toggling one does not affect another', async () => {
    const sess2: Session = { ...sessionFixture, id: 'sess-2' };
    // Different summary text per session so we can disambiguate.
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

    // Two expand chevrons, both starting collapsed.
    const expandBtns = screen.getAllByRole('button', { name: /expand summary/i });
    expect(expandBtns).toHaveLength(2);

    // Expand only the first row.
    fireEvent.click(expandBtns[0]);
    expect(screen.getByText('Summary paragraph here, with details.')).toBeTruthy();
    expect(screen.queryByText('Second paragraph body.')).toBeNull();
  });

  it('falls back to first_message when no sidecar exists', async () => {
    vi.mocked(api.summaryGet).mockResolvedValueOnce(null);
    render(<SessionList sessions={[sessionFixture]} projectPath="/x" />);
    expect(await screen.findByText(/old first message preview/)).toBeTruthy();
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
    // Override the keyed getSetting stub: enabled='false' should hide
    // cached sidecars and the refresh icon regardless of which account
    // resolves. The auto-on-close flag is unrelated here — only the
    // master "enabled" toggle gates SessionList's UI.
    vi.mocked(api.getSetting).mockImplementation(async (key: string) => {
      if (key === 'sessionsSummary.enabled') return 'false';
      return null;
    });
    render(<SessionList sessions={[sessionFixture]} projectPath="/x" />);
    // Global toggle off → cached sidecars on disk are NOT shown; the row
    // falls back to the first-message preview. summaryGet's mock might
    // land before or after resolveAccountForProject's mock — we wait
    // until BOTH have been called AND React has flushed the resulting
    // state (signal: the resolved fallback span has fully rendered).
    await waitFor(() => {
      expect(api.summaryGet).toHaveBeenCalled();
      expect(api.resolveAccountForProject).toHaveBeenCalled();
      expect(screen.queryByText(/old first message preview/)).not.toBeNull();
      expect(screen.queryByText('Summary headline here.')).toBeNull();
    });
    expect(screen.queryByRole('button', { name: /refresh summary/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /generate summary/i })).toBeNull();
  });

  it('hides the summary and refresh icon when the resolved account has no model selected', async () => {
    vi.mocked(api.resolveAccountForProject).mockResolvedValueOnce({
      agent: 'claude',
      account: {
        id: 1,
        name: 'Test',
        config_dir: '/x/.claude',
        account_type: 'pro',
        color: null,
        icon: null,
        cli_path: null,
        created_at: '',
        updated_at: '',
        summarizeOnClose: true,
        summaryModel: null, // no model
      },
    });
    render(<SessionList sessions={[sessionFixture]} projectPath="/x" />);
    await waitFor(() => {
      expect(api.summaryGet).toHaveBeenCalled();
      expect(api.resolveAccountForProject).toHaveBeenCalled();
      expect(screen.queryByText(/old first message preview/)).not.toBeNull();
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
    expect(btn.getAttribute('title')).toMatch(/no new messages/i);
  });

  it('spins the refresh icon when a backend "generating: true" event arrives, and stops on "generating: false"', async () => {
    // Use a session whose JSONL size differs from the cached summary so
    // the refresh button isn't disabled by the size-gate. Title text
    // tracks isRefreshing — that's the renderer's spinner signal.
    const sessionWithDifferentSize: Session = {
      ...sessionFixture,
      file_size_bytes: 9999,
    };
    render(<SessionList sessions={[sessionWithDifferentSize]} projectPath="/x" />);
    const btn = await screen.findByRole('button', { name: /refresh summary/i });
    // Initial state: not generating.
    expect(btn.getAttribute('title')).not.toMatch(/generating/i);

    // Simulate the backend firing "generating: true" for this session.
    expect(generatingCallbackRef.current).not.toBeNull();
    generatingCallbackRef.current!({
      sessionUuid: sessionFixture.id,
      generating: true,
    });
    await waitFor(() => {
      expect(
        screen
          .getByRole('button', { name: /refresh summary/i })
          .getAttribute('title'),
      ).toMatch(/generating/i);
    });

    // Now fire "generating: false" — spinner should clear.
    generatingCallbackRef.current!({
      sessionUuid: sessionFixture.id,
      generating: false,
    });
    await waitFor(() => {
      expect(
        screen
          .getByRole('button', { name: /refresh summary/i })
          .getAttribute('title'),
      ).not.toMatch(/generating/i);
    });
  });

  it('seeds the spinner on mount from getGeneratingSummaryUuids (back-button race fix)', async () => {
    // The lifecycle hook may have fired `generating: true` BEFORE the
    // SessionList finished subscribing — common when the user clicks
    // the back button inside a session, since close + nav happen in
    // the same frame. The component recovers by querying the in-flight
    // set on mount and seeding spinner state from the result.
    vi.mocked(api.getGeneratingSummaryUuids).mockResolvedValueOnce([sessionFixture.id]);
    const sessionWithDifferentSize: Session = {
      ...sessionFixture,
      file_size_bytes: 9999,
    };
    render(<SessionList sessions={[sessionWithDifferentSize]} projectPath="/x" />);
    await screen.findByText('Summary headline here.');
    await waitFor(() => {
      expect(
        screen
          .getByRole('button', { name: /refresh summary/i })
          .getAttribute('title'),
      ).toMatch(/generating/i);
    });
  });

  it('ignores "generating" events for session ids not in the current list', async () => {
    const sessionWithDifferentSize: Session = {
      ...sessionFixture,
      file_size_bytes: 9999,
    };
    render(<SessionList sessions={[sessionWithDifferentSize]} projectPath="/x" />);
    const btn = await screen.findByRole('button', { name: /refresh summary/i });
    const initialTitle = btn.getAttribute('title');

    // Fire an event for a session that isn't on this page — title
    // should stay exactly the same.
    expect(generatingCallbackRef.current).not.toBeNull();
    generatingCallbackRef.current!({
      sessionUuid: 'some-other-session',
      generating: true,
    });
    // Give React a tick.
    await new Promise((r) => setTimeout(r, 50));
    expect(
      screen.getByRole('button', { name: /refresh summary/i }).getAttribute('title'),
    ).toBe(initialTitle);
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

    // Wait for the row to render fully (resolution + summaryGet flush).
    await screen.findByText(/old first message preview/);

    // Click the cells whose chrome is purely informational. The Date
    // cell IS a launch target now (its own test below), so it's
    // excluded from this assertion. cells[0]=Date (launch),
    // cells[1]=Summary, cells[2]=Session ID, cells[3]=actions.
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

    // The date cell is wrapped in a `<button title="Launch session">`.
    // Two such buttons exist per row — the date and the rightmost
    // action icon. Click the one whose textContent contains a date
    // string ("/" appears in the formatted date but not in the icon
    // button's accessible name).
    const launchButtons = screen.getAllByRole('button', { name: /launch session/i });
    const dateBtn = launchButtons.find((b) => /\d+\/\d+\/\d+/.test(b.textContent ?? ''));
    expect(dateBtn).toBeDefined();
    fireEvent.click(dateBtn!);
    expect(onSessionClick).toHaveBeenCalledTimes(1);
    expect(onSessionClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sess-1' }),
    );
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

    // Two "Launch session" buttons per row now — the date launcher
    // (text content includes a formatted date) and the rightmost icon
    // launcher (icon-only, textContent empty). Pick the icon-only one.
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
    // jsdom has no `navigator.clipboard` — define one before clicking the
    // copy button so the stopPropagation handler doesn't blow up with an
    // unhandled "Cannot read properties of undefined (reading 'writeText')"
    // exception. We restore at the end.
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

      // copy-ID: title contains "Copy full session ID"
      const copyBtn = screen
        .getAllByRole('button')
        .find((b) => /copy full session id/i.test(b.getAttribute('title') ?? ''));
      expect(copyBtn).toBeDefined();
      fireEvent.click(copyBtn!);

      // expand chevron
      fireEvent.click(screen.getByRole('button', { name: /expand summary/i }));

      // summary refresh
      fireEvent.click(screen.getByRole('button', { name: /refresh summary/i }));

      // trash (opens dialog — does NOT call onSessionClick)
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
  // Codex rollouts whose recorded `cwd` matches the test's projectPath.
  // Filtering to the active project happens client-side in SessionList.
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

  it('renders a Codex row with badge when api.listCodexSessions returns an entry under this project', async () => {
    vi.mocked(api.listCodexSessions).mockResolvedValueOnce([codexEntry]);
    vi.mocked(api.summaryGet).mockResolvedValue(null);
    render(<SessionList sessions={[]} projectPath="/x" />);
    // Codex badge → uppercase label in the row's first cell.
    expect(await screen.findByText(/codex/i)).toBeTruthy();
    // Conversation id is rendered (first 8 chars are surfaced as the copy-id label).
    expect(screen.getByText(codexEntry.conversationId.slice(0, 8))).toBeTruthy();
  });

  it('filters Codex entries whose projectPath does NOT match the current project', async () => {
    vi.mocked(api.listCodexSessions).mockResolvedValueOnce([
      codexEntry,
      codexEntryOtherProject,
    ]);
    vi.mocked(api.summaryGet).mockResolvedValue(null);
    render(<SessionList sessions={[]} projectPath="/x" />);
    // Only the /x row should be in the table.
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
    // Wait for both rows to mount — Claude (from `sessions` prop) + Codex
    // (from the walker mock). Both must be visible BEFORE we flip the
    // filter, otherwise we're asserting on an async-mount race.
    await screen.findByText(codexEntry.conversationId.slice(0, 8));
    expect(screen.getByText(/sess-1/)).toBeTruthy();

    // The filter renders only when both engines have rows. Click "Claude".
    const claudeFilter = screen
      .getAllByRole('button', { pressed: false })
      .find((b) => /^claude$/i.test(b.textContent ?? ''));
    expect(claudeFilter).toBeDefined();
    fireEvent.click(claudeFilter!);

    // Codex row is now gone; Claude row is still there.
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

      // The Codex row has TWO "Launch Codex session" buttons (date launcher
      // + rightmost icon). Either is a valid click; both must dispatch.
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
