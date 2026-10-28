// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Skeleton } from '@/components/ui/skeleton';
import { TranscriptSkeleton } from '@/components/claude/TranscriptSkeleton';

afterEach(() => { cleanup(); });

describe('Skeleton', () => {
  it('is shadcn\'s: a pulsing muted block', () => {
    const { container } = render(<Skeleton className="h-4 w-20" />);
    const el = container.firstElementChild!;
    expect(el).toHaveAttribute('data-slot', 'skeleton');
    for (const c of ['animate-pulse', 'rounded-md', 'bg-muted', 'h-4', 'w-20']) expect(el.className).toContain(c);
  });
});

describe('TranscriptSkeleton', () => {
  it('says what it is to assistive tech and is busy', () => {
    render(<TranscriptSkeleton />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveTextContent('Loading conversation');
  });

  it('sketches a few turns: a prompt bubble, a work line, and answer lines', () => {
    const { container } = render(<TranscriptSkeleton turns={2} />);
    expect(container.querySelectorAll('[data-skeleton-turn]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(6);
  });
});
