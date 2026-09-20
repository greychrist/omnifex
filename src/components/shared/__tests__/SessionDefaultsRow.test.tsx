// @vitest-environment jsdom
import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SessionDefaultsRow } from '../SessionDefaultsRow';
import { TooltipProvider } from '../../ui/tooltip-modern';
import type { AccountEngine } from '@/lib/api';
import { ACCOUNT_DEFAULT_MARK } from '@/lib/modelCatalog';

afterEach(() => { cleanup(); });

function Harness({
  engine,
  onModel,
  density,
}: {
  engine: AccountEngine;
  onModel?: (v: string) => void;
  density?: 'default' | 'compact';
}) {
  const [model, setModel] = useState(engine === 'claude' ? 'sonnet' : 'gpt-5-codex');
  const [effort, setEffort] = useState('medium');
  const [permissionMode, setPermissionMode] = useState(
    engine === 'claude' ? 'default' : 'read-only',
  );

  return (
    <TooltipProvider>
      <SessionDefaultsRow
        engine={engine}
        {...(density ? { density } : {})}
        model={model}
        setModel={(v) => { setModel(v); onModel?.(v); }}
        effort={effort}
        setEffort={setEffort}
        permissionMode={permissionMode}
        setPermissionMode={setPermissionMode}
      />
    </TooltipProvider>
  );
}

describe('SessionDefaultsRow', () => {
  it("engine='claude' renders Model, Effort, Permissions fields, no Thinking", () => {
    render(<Harness engine="claude" />);
    expect(screen.getByText('Model')).toBeTruthy();
    expect(screen.getByText('Effort')).toBeTruthy();
    expect(screen.getByText('Permissions')).toBeTruthy();
    expect(screen.queryByText(/thinking/i)).toBeNull();
  });

  it("engine='claude' uses the stylized pickers (no plain labeled selects)", () => {
    render(<Harness engine="claude" />);
    // The stylized pickers are buttons, not <select> with htmlFor labels.
    expect(screen.queryByLabelText(/model/i)).toBeNull();
    // Trigger reflects the current model + permission mode via the shared
    // ModelPicker / PermissionPicker components.
    expect(screen.getByText('Sonnet')).toBeTruthy();
    expect(screen.getByText('Default')).toBeTruthy();
  });

  it("direction='column' stacks the fields vertically", () => {
    const { container } = render(
      <TooltipProvider>
        <SessionDefaultsRow
          engine="claude"
          model="sonnet"
          setModel={() => {}}
          effort="high"
          setEffort={() => {}}
          permissionMode="default"
          setPermissionMode={() => {}}
          direction="column"
        />
      </TooltipProvider>,
    );
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('flex-col');
    expect(root.className).toContain('items-stretch');
  });

  it("engine='claude' model picker lists the fallback catalog incl. Fable 5", () => {
    render(<Harness engine="claude" />);
    fireEvent.click(screen.getByText('Sonnet'));
    expect(screen.getAllByText('Fable 5').length).toBeGreaterThan(0);
    // The "default" entry is relabeled "Account Default" by useModelCatalog
    // (nothing identifies the model without a configDir).
    expect(screen.getAllByText('Account Default').length).toBeGreaterThan(0);
  });

  it("engine='claude' marks the live default model instead of duplicating it", () => {
    render(
      <TooltipProvider>
        <SessionDefaultsRow
          engine="claude"
          model="default"
          setModel={() => {}}
          effort="high"
          setEffort={() => {}}
          permissionMode="default"
          setPermissionMode={() => {}}
          activeDefaultModel="claude-fable-5"
        />
      </TooltipProvider>,
    );
    // One Fable 5 line, marked — not "Fable 5" plus "Account Default (Fable 5)".
    expect(screen.queryByText(/Account Default \(/)).toBeNull();
    fireEvent.click(screen.getByText(`Fable 5 ${ACCOUNT_DEFAULT_MARK}`));
    expect(screen.getAllByText(`Fable 5 ${ACCOUNT_DEFAULT_MARK}`).length).toBe(2); // trigger + row
    expect(screen.queryByText('Fable 5')).toBeNull();
  });

  it("engine='claude' permission picker lists all six CLI modes when opened", () => {
    render(<Harness engine="claude" />);
    // Open the permissions picker (its trigger shows the current mode "Default").
    fireEvent.click(screen.getByText('Default'));
    for (const name of ['Accept Edits', 'Plan', 'No Prompts', 'Auto Review', 'Bypass']) {
      expect(screen.getAllByText(name).length).toBeGreaterThan(0);
    }
  });

  it("engine='codex' renders plain labeled selects, no Thinking", () => {
    render(<Harness engine="codex" />);
    expect(screen.getByLabelText(/model/i)).toBeTruthy();
    expect(screen.getByLabelText(/effort/i)).toBeTruthy();
    expect(screen.getByLabelText(/permissions/i)).toBeTruthy();
    expect(screen.queryByLabelText(/thinking/i)).toBeNull();
  });

  it("engine='codex' permission options include Read-only / Workspace-edit / Full-access", () => {
    render(<Harness engine="codex" />);
    expect(screen.getByText('Read-only')).toBeTruthy();
    expect(screen.getByText('Workspace-edit')).toBeTruthy();
    expect(screen.getByText('Full-access')).toBeTruthy();
  });

  it('changing the codex model select calls setModel', () => {
    const onModel = vi.fn();
    render(<Harness engine="codex" onModel={onModel} />);
    const select = screen.getByLabelText(/model/i);
    fireEvent.change(select, { target: { value: 'gpt-5' } });
    expect(onModel).toHaveBeenCalledWith('gpt-5');
  });
});

describe('SessionDefaultsRow compact density', () => {
  it('keeps a caption above each control', () => {
    render(<Harness engine="claude" density="compact" />);
    expect(screen.getByText('Model')).toBeTruthy();
    expect(screen.getByText('Effort')).toBeTruthy();
    expect(screen.getByText('Permissions')).toBeTruthy();
  });

  it('default density keeps the field labels', () => {
    render(<Harness engine="claude" />);
    expect(screen.getByText('Model')).toBeTruthy();
  });

  it('still exposes all three controls', () => {
    render(<Harness engine="claude" density="compact" />);
    expect(screen.getAllByRole('button')).toHaveLength(3);
  });

  // The reported bug: the control row stretched off the right edge of the
  // session context popover. Each picker's `flex-1` is on its BUTTON, but
  // Popover wraps every trigger in its own div — an `inline-block` one by
  // default, which shrink-wraps its content and never shrinks. The row's
  // min-content was therefore 3 x (widest untruncated trigger), whatever the
  // popover's width. The wrapper has to be the full-width block.
  it('lets each trigger shrink with its field instead of widening the row', () => {
    render(<Harness engine="claude" density="compact" />);
    for (const btn of screen.getAllByRole('button')) {
      const wrapper = btn.parentElement?.parentElement as HTMLElement;
      expect(wrapper.className).toContain('w-full');
      expect(wrapper.className).not.toContain('inline-block');
    }
  });

  it('names each control in a title as well as its caption', () => {
    render(<Harness engine="claude" density="compact" />);
    expect(screen.getByTitle(/^Model:/)).toBeTruthy();
    expect(screen.getByTitle(/^Effort:/)).toBeTruthy();
    expect(screen.getByTitle(/^Permissions:/)).toBeTruthy();
  });

  it('lays the three fields out side by side', () => {
    const { container } = render(<Harness engine="claude" density="compact" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).not.toContain('flex-col');
  });

  it('stacks each caption above its control', () => {
    const { container } = render(<Harness engine="claude" density="compact" />);
    const root = container.firstElementChild as HTMLElement;
    const label = screen.getByText('Model');
    const field = label.parentElement as HTMLElement;
    expect(field.className).toContain('flex-col');
    expect(field.parentElement).toBe(root);
    // Caption first, control under it.
    expect(field.firstElementChild).toBe(label);
  });
});
