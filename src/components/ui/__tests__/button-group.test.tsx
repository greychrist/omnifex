// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ButtonGroup } from '@/components/ui/button-group';

afterEach(() => { cleanup(); });

describe('ButtonGroup', () => {
  it('is a labelled group drawing one border with hairlines between its buttons', () => {
    render(
      <ButtonGroup label="Things">
        <button type="button">a</button>
        <button type="button">b</button>
      </ButtonGroup>,
    );
    const group = screen.getByRole('group', { name: 'Things' });
    expect(group.className).toContain('rounded');
    expect(group.className).toContain('border');
    expect(group.children).toHaveLength(2);
  });

  it('strips its buttons\' own corners and rings', () => {
    render(<ButtonGroup label="Things"><button type="button">a</button></ButtonGroup>);
    const cls = screen.getByRole('group').className;
    expect(cls).toContain('[&>*]:rounded-none!');
    expect(cls).toContain('[&>*]:shadow-none!');
  });

  // The divider is each later child's left border; its color must beat the
  // global `* { border-color }` reset.
  it('draws a visible divider between neighbours', () => {
    render(<ButtonGroup label="Things"><button type="button">a</button><button type="button">b</button></ButtonGroup>);
    const cls = screen.getByRole('group').className;
    expect(cls).not.toContain('[&>*]:border-0');
    expect(cls).toContain('[&>*+*]:border-l');
    expect(cls).toMatch(/\[&>\*\+\*\]:border-l-muted-foreground\/\d+!/);
  });
});
