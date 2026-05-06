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

vi.mock('@/lib/api', async () => {
  return {
    api: {
      summaryGet: vi.fn(),
      summaryGenerate: vi.fn(),
    },
    // Re-export the types so the test file's import path stays clean.
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
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.summaryGet).mockResolvedValue(summaryFixture);
  vi.mocked(api.summaryGenerate).mockResolvedValue({
    ...summaryFixture,
    headline: 'Refreshed headline.',
    paragraph: 'Refreshed paragraph.',
  });
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

  it('clicking refresh calls summaryGenerate and updates the row', async () => {
    render(<SessionList sessions={[sessionFixture]} projectPath="/x" />);
    await screen.findByText('Summary headline here.');
    fireEvent.click(screen.getByRole('button', { name: /refresh summary/i }));
    await waitFor(() =>
      expect(screen.getByText('Refreshed headline.')).toBeTruthy(),
    );
  });
});
