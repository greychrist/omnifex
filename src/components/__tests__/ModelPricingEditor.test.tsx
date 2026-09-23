// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    modelPricingList: vi.fn(),
    modelPricingShipped: vi.fn(),
    modelPricingUpsert: vi.fn(),
    modelPricingDelete: vi.fn(),
  },
}));

vi.mock('@/lib/api', () => ({ api: apiMock }));

import { ModelPricingEditor } from '../ModelPricingEditor';

beforeEach(() => {
  apiMock.modelPricingList.mockResolvedValue([
    { id: 1, pattern: 'opus-4-6', effectiveFrom: '1970-01-01', contextWindow: 1_000_000, updatedAt: 'now' },
  ]);
  apiMock.modelPricingShipped.mockResolvedValue([
    { pattern: 'sonnet', effectiveFrom: '2024-01-01', inputPerM: 3, outputPerM: 15, contextWindow: 200_000 },
  ]);
  apiMock.modelPricingUpsert.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ModelPricingEditor context window', () => {
  it('shows the context window on user rows', async () => {
    render(<ModelPricingEditor />);
    const row = (await screen.findByText('opus-4-6')).closest('tr')!;
    expect(within(row).getByText('1M')).toBeTruthy();
  });

  it('shows the context window on built-in rows', async () => {
    render(<ModelPricingEditor />);
    fireEvent.click(await screen.findByText(/Built-in rates/));
    const row = screen.getByText('sonnet').closest('tr')!;
    expect(within(row).getByText('200k')).toBeTruthy();
  });

  it('saves a context window typed into the draft row', async () => {
    render(<ModelPricingEditor />);
    await screen.findByText('opus-4-6');
    fireEvent.change(screen.getByLabelText('Model pattern'), { target: { value: 'opus-9' } });
    fireEvent.change(screen.getByLabelText('Context window'), { target: { value: '1000000' } });
    fireEvent.click(screen.getByText('Save row'));
    await waitFor(() => expect(apiMock.modelPricingUpsert).toHaveBeenCalled());
    expect(apiMock.modelPricingUpsert.mock.calls[0][0]).toMatchObject({ pattern: 'opus-9', contextWindow: 1_000_000 });
  });
});
