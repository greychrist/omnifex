// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ReadoutLabel } from '@/components/ui/readout-label';

afterEach(() => { cleanup(); });

describe('ReadoutLabel', () => {
  // The colon is drawn by CSS, so the label's text stays the bare word.
  it('is the muted label with a colon drawn after it', () => {
    render(<ReadoutLabel>model</ReadoutLabel>);
    const el = screen.getByText('model');
    expect(el.textContent).toBe('model');
    expect(el.className).toContain('opacity-70');
    expect(el.className).toContain("after:content-[':']");
  });
});
