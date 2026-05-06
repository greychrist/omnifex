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
          const { initial, animate, exit, transition, layout, ...domProps } = rest as any;
          void initial; void animate; void exit; void transition; void layout;
          // eslint-disable-next-line react/no-children-prop
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
const STUB_ACCOUNTS: ReadonlyArray<never> = Object.freeze([]);
vi.mock('@/contexts/AccountsContext', () => ({
  useAccounts: () => ({
    accounts: STUB_ACCOUNTS,
    refresh: async () => {},
    getColor: () => null,
    getIcon: () => null,
    getAccountType: () => null,
  }),
}));

vi.mock('@/lib/api', async () => {
  return {
    api: {
      summaryGet: vi.fn(),
      summaryGenerate: vi.fn(),
      onSessionSummaryUpdated: vi.fn(() => () => {}),
      resolveAccountForProject: vi.fn(),
      // The component reads this on mount to hash the active prompt
      // template. Tests don't care about the value; null skips the
      // prompt-hash compare.
      getSetting: vi.fn(async () => null),
    },
    // Mirror the setting key constant the component imports.
    PROMPT_TEMPLATE_SETTING_KEY: 'sessionsSummary.promptTemplate',
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
  // Default: account has summarization enabled — so the refresh icon
  // renders. Individual tests override for the disabled-account case.
  vi.mocked(api.resolveAccountForProject).mockResolvedValue({
    id: 1,
    name: 'Test',
    config_dir: '/x/.claude',
    is_default: true,
    account_type: 'pro',
    color: null,
    icon: null,
    cli_path: null,
    created_at: '',
    updated_at: '',
    summarizeOnClose: true,
    summaryModel: 'haiku',
  } as any);
});

afterEach(() => cleanup());

describe('SessionList summary rendering', () => {
  it('renders the summary headline when a sidecar exists', async () => {
    render(<SessionList sessions={[sessionFixture]} projectPath="/x" />);
    expect(await screen.findByText('Summary headline here.')).toBeTruthy();
    // Paragraph hidden until expanded.
    expect(screen.queryByText('Summary paragraph here, with details.')).toBeNull();
  });

  it('reveals the paragraph when the chevron is clicked', async () => {
    render(<SessionList sessions={[sessionFixture]} projectPath="/x" />);
    await screen.findByText('Summary headline here.');
    fireEvent.click(screen.getByRole('button', { name: /expand summary/i }));
    expect(screen.getByText('Summary paragraph here, with details.')).toBeTruthy();
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
    } as Session;
    render(<SessionList sessions={[sessionWithDifferentSize]} projectPath="/x" />);
    await screen.findByText('Summary headline here.');
    fireEvent.click(screen.getByRole('button', { name: /refresh summary/i }));
    await waitFor(
      () => expect(screen.getByText('Refreshed headline.')).toBeTruthy(),
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
    } as Session;
    render(<SessionList sessions={[sessionWithDifferentSize]} projectPath="/x" />);
    await screen.findByText('Summary headline here.');
    fireEvent.click(screen.getByRole('button', { name: /refresh summary/i }));
    await waitFor(
      () =>
        expect(
          screen.getByText(/Summaries are off for this account/i),
        ).toBeTruthy(),
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
    } as Session;
    render(<SessionList sessions={[sessionWithDifferentSize]} projectPath="/x" />);
    await screen.findByText('Summary headline here.');
    fireEvent.click(screen.getByRole('button', { name: /refresh summary/i }));
    await waitFor(
      () =>
        expect(
          screen.getByText(/No summary model selected/i),
        ).toBeTruthy(),
      { timeout: 2000 },
    );
  });

  it('hides the summary and refresh icon when the resolved account has summarization disabled', async () => {
    vi.mocked(api.resolveAccountForProject).mockResolvedValueOnce({
      id: 1,
      name: 'Test',
      config_dir: '/x/.claude',
      is_default: true,
      account_type: 'pro',
      color: null,
      icon: null,
      cli_path: null,
      created_at: '',
      updated_at: '',
      summarizeOnClose: false, // toggle off
      summaryModel: 'haiku',
    } as any);
    render(<SessionList sessions={[sessionFixture]} projectPath="/x" />);
    // Toggle off → cached sidecars on disk are NOT shown; the row falls
    // back to the first-message preview. summaryGet's mock might land
    // before or after resolveAccountForProject's mock — we wait until
    // BOTH have been called AND React has flushed the resulting state
    // (signal: the resolved fallback span has fully rendered).
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
      id: 1,
      name: 'Test',
      config_dir: '/x/.claude',
      is_default: true,
      account_type: 'pro',
      color: null,
      icon: null,
      cli_path: null,
      created_at: '',
      updated_at: '',
      summarizeOnClose: true,
      summaryModel: null, // no model
    } as any);
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
    } as Session;
    render(<SessionList sessions={[sessionWithSameSize]} projectPath="/x" />);
    await screen.findByText('Summary headline here.');
    const btn = screen.getByRole('button', { name: /refresh summary/i });
    expect(btn.hasAttribute('disabled')).toBe(true);
    expect(btn.getAttribute('title')).toMatch(/no new messages/i);
  });
});
