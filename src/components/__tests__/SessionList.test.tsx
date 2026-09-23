// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { Session, SessionSummary } from '@/lib/api';

// framer-motion is deliberately NOT mocked here.
//
// There used to be a `vi.mock` that rendered `motion.tr` as a plain `tr` via
// `require('react')`. Under Vite that resolves the CJS interop copy — a SECOND
// React instance — so nothing inside a motion-created subtree could update
// state. Every Radix tooltip in the list stayed `data-state="closed"` however
// it was triggered, which reads exactly like a broken product. The real
// library renders these rows fine in jsdom, so the mock bought nothing and
// cost an hour.

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
      // Per-session cost rows from the durable cost-history table, keyed
      // by session_id. Default: none; cost-aware tests override.
      sessionCostSessions: vi.fn(async () => [] as Array<{
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
  // Default: account has a summary model picked + global auto-on-close
  // is on (mocked above) → refresh icon renders. Individual tests can
  // override either by re-mocking before render.
  // resolveAccountForProject returns a ResolvePair; the Claude account
  // resolves into the `claude` slot.
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

  // Reset the keyed getSetting stub on every test so individual cases
  // can override one key without leaking into others.
  vi.mocked(api.getSetting).mockImplementation(async (key: string) => {
    if (key === 'sessionsSummary.enabled') return 'true';
    return null;
  });
});

/**
 * Radix positions tooltip content with floating-ui, which measures through
 * ResizeObserver — absent in jsdom, so the content never mounts and every
 * tooltip assertion times out. Same stub the CostChart test uses for recharts.
 */
beforeAll(() => {
  class StubResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
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

  // No first-prompt fallback: a row with neither a name nor a summary says so
  // plainly, so a missing summary or title is noticeable rather than papered
  // over with the opening prompt.
  it('shows "No name" — never the first prompt — when there is no title and no summary', async () => {
    vi.mocked(api.summaryGet).mockResolvedValueOnce(null);
    render(<SessionList sessions={[sessionFixture]} projectPath="/x" />);
    expect(await screen.findByText('No name')).toBeTruthy();
  });

  // The CLI names every session itself and writes the name into the
  // transcript as an `ai-title` record; getProjectSessions surfaces it as
  // `ai_title`. The title is the row's identity, so it always takes the label
  // when present — what sits beneath it is the summary if one exists, and
  // nothing otherwise.
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

    // Await the SUMMARY first, not the title. summaryGet is async, so there
    // is a window on mount where no summary has arrived and the title-only
    // branch renders — asserting on the title first passes in that window and
    // proves nothing about the settled row.
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

    // A rename made in the session's status bar is the user's own word for
    // what the session is. It has to reach this list, or renaming a session
    // looks like it did nothing everywhere except the tab it was done in.
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

  // The row's action icons used the native `title` attribute, which is at the
  // mercy of the OS hover heuristic: it wants ~1s of a stationary pointer over
  // a node that is not being re-created, is not animating, and whose `title`
  // has not changed. Session rows break all three — `motion.tr` staggers an
  // entry animation by `index * 0.02`, per-row summaries arrive asynchronously
  // and change row height, and the summary button's title moves between four
  // values. Radix opens on its own timer and describes the trigger through
  // `aria-describedby`, which is both deterministic and assertable.
  //
  // Assert the description, not `role="tooltip"`: Radix gives the visible
  // content no role, exposing it via aria-describedby instead.
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
    // reads "No name". summaryGet's mock might
    // land before or after resolveAccountForProject's mock — we wait
    // until BOTH have been called AND React has flushed the resulting
    // state (signal: the resolved fallback span has fully rendered).
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
    // The "why" moved from a `title` attribute into the Radix tooltip; the
    // 'icon tooltips' block asserts its text on focus.
  });

  it('spins the refresh icon when a backend "generating: true" event arrives, and stops on "generating: false"', async () => {
    // Use a session whose JSONL size differs from the cached summary so
    // the refresh button isn't disabled by the size-gate. The spinning glyph
    // is the renderer's signal — assert that rather than tooltip prose, which
    // only exists in the DOM while the tooltip is open.
    const sessionWithDifferentSize: Session = {
      ...sessionFixture,
      file_size_bytes: 9999,
    };
    render(<SessionList sessions={[sessionWithDifferentSize]} projectPath="/x" />);
    const btn = await screen.findByRole('button', { name: /refresh summary/i });
    // Initial state: not generating.
    expect(isSpinning(btn)).toBe(false);

    // Simulate the backend firing "generating: true" for this session.
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

    // Now fire "generating: false" — spinner should clear.
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

    // Fire an event for a session that isn't on this page — this row must not
    // start spinning.
    expect(generatingCallbackRef.current).not.toBeNull();
    generatingCallbackRef.current!({
      sessionUuid: 'some-other-session',
      generating: true,
    });
    // Give React a tick.
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

    // Wait for the row to render fully (resolution + summaryGet flush).
    await screen.findByText('No name');

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

      // copy-ID — named by aria-label now that the tooltip owns the prose.
      const copyBtn = screen.getByRole('button', { name: /copy session id/i });
      fireEvent.click(copyBtn);

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

  it('renders a Codex row with engine icon when api.listCodexSessions returns an entry under this project', async () => {
    vi.mocked(api.listCodexSessions).mockResolvedValueOnce([codexEntry]);
    vi.mocked(api.summaryGet).mockResolvedValue(null);
    render(<SessionList sessions={[]} projectPath="/x" />);
    // Codex engine → icon with accessible name in the Date cell.
    expect(await screen.findByLabelText('Codex session')).toBeTruthy();
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
    // Size and Cost both fall back to em-dash; at least one present.
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
  });

  it('no longer renders a standalone "Claude" agent-type label, but keeps the icon', async () => {
    render(<SessionList sessions={[sessionFixture]} projectPath="/x" />);
    await screen.findByText('No name');
    // The old dedicated agent column rendered the literal text "Claude".
    expect(screen.queryByText('Claude', { exact: true })).toBeNull();
    // The engine is still identified by an icon with an accessible name.
    expect(screen.getAllByLabelText('Claude session').length).toBeGreaterThanOrEqual(1);
  });
});

