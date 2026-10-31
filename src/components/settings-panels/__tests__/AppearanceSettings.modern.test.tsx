// @vitest-environment jsdom
/**
 * Appearance › Modern: the Modern chat format's own settings, beside a live
 * sample drawn by the real Modern components. It took the Terminal tab's place.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';

vi.mock('@/lib/api', () => ({
  api: {
    getSetting: vi.fn(async () => null),
    saveSetting: vi.fn(async () => {}),
    logWriteBatch: vi.fn(async () => {}),
  },
}));
vi.mock('@/hooks/useLayoutMode', () => ({ useLayoutMode: () => ({ touch: false }) }));
vi.mock('@/hooks', async (orig) => ({
  ...(await orig<typeof import('@/hooks')>()),
  useTheme: () => ({ theme: 'gray', setTheme: () => {}, isLoading: false }),
}));

import { api } from '@/lib/api';
import { AppearanceSettings } from '../AppearanceSettings';
import { SaveStatusProvider } from '../saveStatus';
import { MessageRenderingProvider } from '@/contexts/MessageRenderingContext';

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  vi.mocked(api.getSetting).mockResolvedValue(null);
  vi.mocked(api.saveSetting).mockResolvedValue();
});
afterEach(cleanup);

function savedModern(): Record<string, unknown>[] {
  return vi.mocked(api.saveSetting).mock.calls
    .map(([, v]) => (JSON.parse(String(v)) as { modern?: Record<string, unknown> }).modern)
    .filter((m): m is Record<string, unknown> => !!m);
}

async function openModern() {
  sessionStorage.setItem('omnifex:appearance-tab', 'modern');
  render(
    <MessageRenderingProvider>
      <SaveStatusProvider>
        <AppearanceSettings setToast={vi.fn()} />
      </SaveStatusProvider>
    </MessageRenderingProvider>,
  );
  return screen.findByTestId('modern-editor');
}

describe('AppearanceSettings — Modern', () => {
  it('has a Modern tab and no Terminal tab', async () => {
    await openModern();
    expect(screen.getByRole('tab', { name: 'Modern' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Terminal' })).toBeNull();
  });

  it('shows a sample drawn by the Modern format', async () => {
    await openModern();
    const sample = screen.getByRole('region', { name: 'Modern sample' });
    expect(sample).toHaveClass('modern-format');
    expect(sample.querySelector('.modern-prompt')).not.toBeNull();
    expect(sample.querySelector('[data-slot="trace"]')).not.toBeNull();
    expect(sample.querySelector('[data-turn-footer]')).toHaveTextContent('Done · 4m 12s · 4 steps · $0.38');
  });

  it('saves the timeline setting', async () => {
    const editor = await openModern();
    fireEvent.click(within(editor).getByRole('radio', { name: 'Always open' }));
    await waitFor(() => { expect(savedModern().some((m) => m.timelineOpen === 'always')).toBe(true); });
  });

  it('saves hiding thoughts', async () => {
    const editor = await openModern();
    fireEvent.click(within(editor).getByRole('switch', { name: 'Show thoughts' }));
    await waitFor(() => { expect(savedModern().some((m) => m.showThoughts === false)).toBe(true); });
  });

  it('saves the font and the answer size', async () => {
    const editor = await openModern();
    fireEvent.click(within(editor).getByRole('radio', { name: 'Typography font' }));
    fireEvent.click(within(editor).getByRole('radio', { name: '16px' }));
    await waitFor(() => {
      expect(savedModern().some((m) => m.font === 'content' && m.answerSize === 16)).toBe(true);
    });
  });

  it('hands the live chats its font, answer size and tint through :root', async () => {
    const editor = await openModern();
    fireEvent.click(within(editor).getByRole('radio', { name: '16px' }));
    fireEvent.change(within(editor).getByLabelText('Prompt bubble color hex'), { target: { value: '#22c55e' } });
    const root = document.documentElement.style;
    await waitFor(() => {
      expect(root.getPropertyValue('--modern-answer-size')).toBe('16px');
      expect(root.getPropertyValue('--modern-prompt-tint')).toBe('#22c55e');
    });
  });

  it('saves a prompt tint and a failed-step colour', async () => {
    const editor = await openModern();
    fireEvent.change(within(editor).getByLabelText('Prompt bubble color hex'), { target: { value: '#22c55e' } });
    fireEvent.change(within(editor).getByLabelText('Failed step color hex'), { target: { value: '#f97316' } });
    await waitFor(() => {
      expect(savedModern().some((m) => m.promptTint === '#22c55e' && m.failedColor === '#f97316')).toBe(true);
    });
  });

  it('saves the answer card colour beside the other two', async () => {
    const editor = await openModern();
    fireEvent.change(within(editor).getByLabelText('Answer card color hex'), { target: { value: '#0ea5e9' } });
    await waitFor(() => { expect(savedModern().some((m) => m.answerCardColor === '#0ea5e9')).toBe(true); });
  });

  // A visible "Reset to …" link on each colour once it is changed, so the
  // way back to the built-in look reads as an action, not a caption.
  it('offers a reset to the built-in colour on each color once changed', async () => {
    const editor = await openModern();
    const fields: [string, string, string][] = [
      ['Prompt bubble', 'built-in blue', 'promptTint'],
      ['Failed step', 'theme red', 'failedColor'],
      ['Answer card', 'built-in green', 'answerCardColor'],
    ];
    for (const [name, builtIn] of fields) {
      expect(within(editor).queryByRole('button', { name: new RegExp(`reset ${name} color`, 'i') })).toBeNull();
      expect(within(editor).getAllByText(builtIn).length).toBeGreaterThan(0);
      fireEvent.change(within(editor).getByLabelText(`${name} color hex`), { target: { value: '#123456' } });
    }
    for (const [name, builtIn, key] of fields) {
      const reset = await within(editor).findByRole('button', { name: new RegExp(`reset ${name} color`, 'i') });
      expect(reset).toHaveTextContent(`Reset to ${builtIn}`);
      fireEvent.click(reset);
      await waitFor(() => { expect(savedModern().at(-1)?.[key]).toBeNull(); });
    }
  });

  it('has a saturation and a brightness slider for each card, each with a reset once moved', async () => {
    const editor = await openModern();
    const sliders: [string, string, string][] = [
      ['Prompt bubble', 'saturation', 'promptSaturation'],
      ['Prompt bubble', 'brightness', 'promptBrightness'],
      ['Answer card', 'saturation', 'answerCardSaturation'],
      ['Answer card', 'brightness', 'answerCardBrightness'],
    ];
    for (const [name, what, key] of sliders) {
      const slider = within(editor).getByRole('slider', { name: `${name} ${what}` });
      expect(slider).toHaveValue('100');
      expect(within(editor).queryByRole('button', { name: `Reset ${name.toLowerCase()} ${what}` })).toBeNull();
      fireEvent.change(slider, { target: { value: '40' } });
      await waitFor(() => { expect(savedModern().at(-1)?.[key]).toBe(40); });
      const reset = await within(editor).findByRole('button', { name: `Reset ${name.toLowerCase()} ${what}` });
      expect(reset).toHaveTextContent('Reset to 100%');
      fireEvent.click(reset);
      await waitFor(() => { expect(savedModern().at(-1)?.[key]).toBe(100); });
    }
    // The failed step is not a card: no sliders.
    expect(within(editor).queryByRole('slider', { name: /failed step/i })).toBeNull();
  });

  // One "Colors" section, the three side by side, between Show thoughts and
  // Step icons.
  it('sets the three colors on one row under a Colors heading, after Show thoughts and before Step icons', async () => {
    const editor = await openModern();
    const section = within(editor).getByRole('region', { name: 'Colors' });
    expect(within(section).getByText('Colors')).toBeInTheDocument();
    const grid = within(section).getByTestId('modern-colors');
    expect(grid.className).toMatch(/\bmd:grid-cols-3\b/);
    expect(grid.children).toHaveLength(3);
    // The two cards first, then the failed step.
    const order = ['Prompt bubble', 'Answer card', 'Failed step'];
    order.forEach((name, i) => {
      expect(within(grid.children[i] as HTMLElement).getByLabelText(`${name} color hex`)).toBeInTheDocument();
    });
    const thoughts = within(editor).getByRole('switch', { name: 'Show thoughts' });
    const icons = within(editor).getByRole('group', { name: 'Thought step icon' });
    expect(thoughts.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(section.compareDocumentPosition(icons) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('has a drop shadow switch for the prompt bubble and the answer card, on by default', async () => {
    const editor = await openModern();
    for (const [name, key] of [['Prompt bubble', 'promptShadow'], ['Answer card', 'answerCardShadow']] as const) {
      const sw = within(editor).getByRole('switch', { name: `${name} drop shadow` });
      expect(sw).toHaveAttribute('aria-checked', 'true');
      fireEvent.click(sw);
      await waitFor(() => { expect(savedModern().at(-1)?.[key]).toBe(false); });
    }
    expect(within(editor).queryByRole('switch', { name: 'Failed step drop shadow' })).toBeNull();
  });

  // Titled by name alone under the Colors heading; "colour" nowhere.
  it('titles each field by its name alone, and never spells it colour', async () => {
    const editor = await openModern();
    const section = within(editor).getByRole('region', { name: 'Colors' });
    for (const name of ['Prompt bubble', 'Failed step', 'Answer card']) {
      expect(within(section).getByText(name, { selector: 'label' })).toBeInTheDocument();
      expect(within(section).queryByText(`${name} color`)).toBeNull();
    }
    expect(editor.textContent).not.toMatch(/colour/i);
  });

  it('has an Enabled checkbox beside the prompt and answer card color titles, on by default', async () => {
    const editor = await openModern();
    for (const [name, key] of [['Prompt bubble', 'promptColorEnabled'], ['Answer card', 'answerCardColorEnabled']] as const) {
      const box = within(editor).getByRole('checkbox', { name: `${name} color enabled` });
      expect(box).toBeChecked();
      // Beside the title, in its row.
      expect(box.closest('div')?.querySelector('label')?.textContent).toBe(name);
      fireEvent.click(box);
      await waitFor(() => { expect(savedModern().at(-1)?.[key]).toBe(false); });
      // Off: the color and its strength cannot be set.
      expect(within(editor).getByLabelText(`${name} color hex`)).toBeDisabled();
      expect(within(editor).getByLabelText(`${name} color picker`)).toBeDisabled();
      expect(within(editor).getByRole('slider', { name: `${name} saturation` })).toBeDisabled();
      expect(within(editor).getByRole('slider', { name: `${name} brightness` })).toBeDisabled();
      // And its drop shadow, which keeps its setting for when color returns.
      const shadow = within(editor).getByRole('switch', { name: `${name} drop shadow` });
      expect(shadow).toBeDisabled();
      expect(shadow).toHaveAttribute('aria-checked', 'true');
    }
    expect(within(editor).queryByRole('checkbox', { name: 'Failed step color enabled' })).toBeNull();
  });

  // A rule between each pair of the four sections: Work timeline | Colors |
  // Step icons | Text.
  it('separates the Work timeline, Colors, Step icons and Text sections with a line', async () => {
    const editor = await openModern();
    const seps = within(editor).getAllByRole('separator');
    expect(seps).toHaveLength(3);
    const order = [
      within(editor).getByRole('switch', { name: 'Show thoughts' }),
      seps[0],
      within(editor).getByRole('region', { name: 'Colors' }),
      seps[1],
      within(editor).getByRole('group', { name: 'Thought step icon' }),
      seps[2],
      within(editor).getByRole('radiogroup', { name: 'Font' }),
    ];
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('lists an icon for every kind of step', async () => {
    const editor = await openModern();
    for (const label of ['Thought', 'Command', 'Commit', 'Read', 'Edit', 'Web', 'Agent', 'MCP tool', 'Other tool']) {
      expect(within(editor).getByRole('group', { name: `${label} step icon` })).toBeInTheDocument();
    }
  });
});
