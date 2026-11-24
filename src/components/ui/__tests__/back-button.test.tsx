// @vitest-environment jsdom
import * as React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react';
import { TooltipProvider } from '../tooltip-modern';
import { BackButton } from '../back-button';
import { NewSessionButton } from '../../NewSessionButton';

afterEach(() => { cleanup(); });

const renderIn = (node: React.ReactNode) => render(<TooltipProvider>{node}</TooltipProvider>);

describe('BackButton', () => {
  it('goes back when pressed, named for where it goes', () => {
    const onClick = vi.fn();
    renderIn(<BackButton label="Back to Projects" onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: 'Back to Projects' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('shows a styled tooltip, not a native title', async () => {
    renderIn(<BackButton label="Back to Projects" onClick={vi.fn()} />);
    const btn = screen.getByRole('button', { name: 'Back to Projects' });
    expect(btn.hasAttribute('title')).toBe(false);
    act(() => { btn.focus(); });
    expect((await screen.findByRole('tooltip')).textContent).toBe('Back to Projects');
  });

  it('wears the same chrome at every size, and the same as the button beside it in a session', () => {
    renderIn(
      <>
        <BackButton label="small" onClick={vi.fn()} />
        <BackButton label="large" size="md" onClick={vi.fn()} />
        <NewSessionButton onClick={vi.fn()} />
      </>,
    );
    const chrome = (el: HTMLElement) =>
      el.className.split(/\s+/).filter((c) => !/^[hw]-\d+$/.test(c)).sort().join(' ');
    const small = screen.getByRole('button', { name: 'small' });
    const large = screen.getByRole('button', { name: 'large' });
    const sibling = screen.getByRole('button', { name: /new session/i });
    expect(chrome(large)).toBe(chrome(small));
    expect(chrome(sibling)).toBe(chrome(small));
    expect(small.className).toContain('h-7');
    expect(large.className).toContain('h-8');
  });

  // The sessions page, Project Settings and the file picker sit under no
  // TooltipProvider.
  it('renders with no TooltipProvider above it', () => {
    render(<BackButton label="Back to Projects" onClick={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Back to Projects' })).toBeTruthy();
  });

  it('is disabled when told to', () => {
    const onClick = vi.fn();
    renderIn(<BackButton label="Back" onClick={onClick} disabled />);
    const btn = screen.getByRole('button', { name: 'Back' });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });
});
