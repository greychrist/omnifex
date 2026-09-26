// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, cleanup } from '@testing-library/react';
import { CommandWidget, CommandOutputWidget } from '@/components/claude/tools/CommandWidget';

// These render inside a MessageFrame, which already supplies the border,
// header and icon. A second bordered box with its own "Command" / "Output"
// strip read as a card within a card, and a hard-coded text-sm set the body a
// size above every other system card's text-xs.
describe('command widgets', () => {
  afterEach(cleanup);

  it('the command renders bare: no inner box or header strip', () => {
    const { container, queryByText, getByText } = render(<CommandWidget commandName="/usage" commandMessage="usage" commandArgs="week" />);
    expect(container.querySelector('.border, .rounded-lg')).toBeNull();
    expect(queryByText('Command')).toBeNull();
    expect(getByText('/usage')).toHaveClass('text-xs');
  });

  it('the output renders bare, at the size of other system card bodies', () => {
    const { container, queryByText } = render(<CommandOutputWidget output={'Current session: 5% used'} />);
    expect(container.querySelector('.border, .rounded-lg')).toBeNull();
    expect(queryByText('Output')).toBeNull();
    const pre = container.querySelector('pre');
    expect(pre).toHaveClass('text-xs');
    expect(pre).not.toHaveClass('text-sm');
  });
});
