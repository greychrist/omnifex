// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { SessionStatusBar } from '../SessionStatusBar';

afterEach(() => { cleanup(); });

// The turn clock and thinking-burst coverage that used to live here moved with
// those glyphs to ChatStatusBar.test.tsx. What remains is the one fact that is
// genuinely about the session rather than the current turn.
describe('SessionStatusBar', () => {
  it('shows the subagent glyph only when agents are running', () => {
    const { rerender } = render(<SessionStatusBar activeSubagents={0} />);
    expect(screen.queryByLabelText(/background agent/i)).toBeNull();

    rerender(<SessionStatusBar activeSubagents={3} />);
    expect(screen.getByLabelText(/3 background agents working/i)).toBeTruthy();
  });

  it('renders nothing when no agents are running', () => {
    const { container } = render(<SessionStatusBar activeSubagents={0} />);
    expect(container.innerHTML).toBe('');
  });
});
