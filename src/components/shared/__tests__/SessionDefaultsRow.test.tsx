// @vitest-environment jsdom
import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SessionDefaultsRow } from '../SessionDefaultsRow';
import { TooltipProvider } from '../../ui/tooltip-modern';
import type { AccountEngine } from '@/lib/api';

afterEach(() => { cleanup(); });

function Harness({
  engine,
  onModel,
}: {
  engine: AccountEngine;
  onModel?: (v: string) => void;
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
    // The "default" entry is relabeled "Account Default" by useModelCatalog.
    expect(screen.getAllByText('Account Default').length).toBeGreaterThan(0);
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
