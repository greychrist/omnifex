// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { GitWatchStatusIcon } from '@/components/claude-code-session/GitWatchStatusIcon';

afterEach(() => { cleanup(); });

describe('GitWatchStatusIcon', () => {
  // It sits in the bar's button group beside the repos button, which has no
  // fill; the bar shows through both.
  it('has a clear background, filling only on hover', () => {
    render(<GitWatchStatusIcon errors={[]} onReconnect={async () => {}} />);
    const cls = screen.getByRole('button').className.split(' ');
    expect(cls).toContain('bg-transparent');
    expect(cls).not.toContain('bg-background');
    expect(cls).toContain('hover:bg-accent');
  });
});
