// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTuiPromptHandler } from '../tuiPromptHandler';
import { api } from '../api';

vi.mock('../api', () => ({
  api: { tuiWrite: vi.fn(async () => {}) },
}));

const tuiWrite = vi.mocked(api.tuiWrite);

beforeEach(() => { tuiWrite.mockReset(); });

describe('createTuiPromptHandler', () => {
  it("writes the prompt + '\\r' to the TUI's PTY", () => {
    const handler = createTuiPromptHandler('tab-1');
    handler('hello world', 'claude-opus-4-7');
    expect(tuiWrite).toHaveBeenCalledExactlyOnceWith('tab-1', 'hello world\r');
  });

  it('preserves embedded newlines (multi-line prompts are typed as-is)', () => {
    const handler = createTuiPromptHandler('tab-1');
    handler('line 1\nline 2', 'claude-opus-4-7');
    expect(tuiWrite).toHaveBeenCalledExactlyOnceWith('tab-1', 'line 1\nline 2\r');
  });

  it('skips empty / whitespace-only prompts', () => {
    const handler = createTuiPromptHandler('tab-1');
    handler('', 'claude-opus-4-7');
    handler('   \n  ', 'claude-opus-4-7');
    expect(tuiWrite).not.toHaveBeenCalled();
  });

  it('silently drops image attachments (CLI TUI stdin does not accept them)', () => {
    const handler = createTuiPromptHandler('tab-1');
    handler('inspect this', 'claude-opus-4-7', ['data:image/png;base64,iVBOR...']);
    expect(tuiWrite).toHaveBeenCalledExactlyOnceWith('tab-1', 'inspect this\r');
  });
});
