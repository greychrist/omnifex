// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('@/lib/api', async () => {
  return {
    api: {
      getSetting: vi.fn(async (_key: string) => null),
      saveSetting: vi.fn(async () => {}),
    },
    PROMPT_TEMPLATE_SETTING_KEY: 'sessionsSummary.promptTemplate',
    AUTO_ON_CLOSE_SETTING_KEY: 'sessionsSummary.autoOnClose',
    ENABLED_SETTING_KEY: 'sessionsSummary.enabled',
  };
});

import { api } from '@/lib/api';
import { SystemPromptSettings } from '../SystemPromptSettings';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getSetting).mockImplementation(async () => null);
  vi.mocked(api.saveSetting).mockResolvedValue();
});

afterEach(() => {
  cleanup();
});

describe('SystemPromptSettings', () => {
  it('renders a sub-tab for each system prompt OmniFex sends', async () => {
    render(<SystemPromptSettings />);
    expect(screen.getByRole('tab', { name: /session summaries/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /compactions/i })).toBeTruthy();
  });

  it('opens on Session summaries', async () => {
    render(<SystemPromptSettings />);
    await screen.findByRole('heading', { name: 'Session Summaries' });
    expect(screen.queryByRole('heading', { name: 'Compactions' })).toBeNull();
  });

  it('switches to the Compactions panel', async () => {
    render(<SystemPromptSettings />);
    await screen.findByRole('heading', { name: 'Session Summaries' });

    fireEvent.click(screen.getByRole('tab', { name: /compactions/i }));

    await screen.findByRole('heading', { name: 'Compactions' });
    expect(screen.queryByRole('heading', { name: 'Session Summaries' })).toBeNull();
  });

  it('switches back to Session summaries', async () => {
    render(<SystemPromptSettings />);
    await screen.findByRole('heading', { name: 'Session Summaries' });

    fireEvent.click(screen.getByRole('tab', { name: /compactions/i }));
    await screen.findByRole('heading', { name: 'Compactions' });

    fireEvent.click(screen.getByRole('tab', { name: /session summaries/i }));
    await screen.findByRole('heading', { name: 'Session Summaries' });
  });
});
