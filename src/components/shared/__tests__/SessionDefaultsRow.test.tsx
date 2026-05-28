// @vitest-environment jsdom
import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SessionDefaultsRow } from '../SessionDefaultsRow';
import type { AccountEngine } from '@/lib/api';

afterEach(() => { cleanup(); });

function Harness({
  engine,
  onModel,
}: {
  engine: AccountEngine;
  onModel?: (v: string) => void;
}) {
  const [model, setModel] = useState(engine === 'claude' ? 'opus' : 'gpt-5-codex');
  const [effort, setEffort] = useState('medium');
  const [permissionMode, setPermissionMode] = useState(
    engine === 'claude' ? 'default' : 'read-only',
  );

  return (
    <SessionDefaultsRow
      engine={engine}
      model={model}
      setModel={(v) => { setModel(v); onModel?.(v); }}
      effort={effort}
      setEffort={setEffort}
      permissionMode={permissionMode}
      setPermissionMode={setPermissionMode}
    />
  );
}

describe('SessionDefaultsRow', () => {
  it("engine='claude' renders Model, Effort, Permissions but no Thinking", () => {
    render(<Harness engine="claude" />);
    expect(screen.getByLabelText(/model/i)).toBeTruthy();
    expect(screen.getByLabelText(/effort/i)).toBeTruthy();
    expect(screen.getByLabelText(/permissions/i)).toBeTruthy();
    expect(screen.queryByLabelText(/thinking/i)).toBeNull();
  });

  it("engine='codex' renders Model, Effort, Permissions but no Thinking", () => {
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

  it('changing the model select calls setModel', () => {
    const onModel = vi.fn();
    render(<Harness engine="claude" onModel={onModel} />);
    const select = screen.getByLabelText(/model/i);
    fireEvent.change(select, { target: { value: 'haiku' } });
    expect(onModel).toHaveBeenCalledWith('haiku');
  });
});
