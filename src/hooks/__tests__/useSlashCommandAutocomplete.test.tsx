// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useSlashCommandAutocomplete } from '../useSlashCommandAutocomplete';
import type { SlashCommand } from '@/lib/api';

let consoleLogSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // Hook console.log's on `/` detection — keep test output clean.
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  consoleLogSpy.mockRestore();
  cleanup();
});

function makeCommand(partial: Partial<SlashCommand>): SlashCommand {
  return {
    id: 'cmd-id',
    name: 'commit',
    full_command: '/commit',
    scope: 'user',
    namespace: '',
    description: '',
    file_path: '',
    content: '',
    accepts_arguments: false,
    has_bash_commands: false,
    has_file_references: false,
    allowed_tools: [],
    ...partial,
  };
}

describe('useSlashCommandAutocomplete — initial state', () => {
  it('starts with picker closed and empty query', () => {
    const { result } = renderHook(() => useSlashCommandAutocomplete());
    expect(result.current.showSlashCommandPicker).toBe(false);
    expect(result.current.slashCommandQuery).toBe('');
  });
});

describe('useSlashCommandAutocomplete — trigger detection', () => {
  it('opens the picker when "/" is typed at position 0', () => {
    const { result } = renderHook(() => useSlashCommandAutocomplete());
    act(() => { result.current.handleTextChangeForSlash('/', 1, ''); });
    expect(result.current.showSlashCommandPicker).toBe(true);
    expect(result.current.slashCommandQuery).toBe('');
  });

  it('opens the picker when "/" is typed after a space', () => {
    const { result } = renderHook(() => useSlashCommandAutocomplete());
    act(() => { result.current.handleTextChangeForSlash('hello /', 7, 'hello '); });
    expect(result.current.showSlashCommandPicker).toBe(true);
  });

  it('does NOT open the picker when "/" is mid-word (e.g. inside a URL)', () => {
    const { result } = renderHook(() => useSlashCommandAutocomplete());
    act(() => { result.current.handleTextChangeForSlash('http://x', 8, 'http:/'); });
    expect(result.current.showSlashCommandPicker).toBe(false);
  });

  it('does NOT open the picker if the change shortened the text (i.e. user deleted)', () => {
    const { result } = renderHook(() => useSlashCommandAutocomplete());
    // Simulates backspace: prev was longer than new.
    act(() => { result.current.handleTextChangeForSlash('/', 1, '/h'); });
    expect(result.current.showSlashCommandPicker).toBe(false);
  });
});

describe('useSlashCommandAutocomplete — query tracking while open', () => {
  it('updates slashCommandQuery as the user types after "/"', () => {
    const { result } = renderHook(() => useSlashCommandAutocomplete());
    act(() => { result.current.handleTextChangeForSlash('/', 1, ''); });
    act(() => { result.current.handleTextChangeForSlash('/c', 2, '/'); });
    expect(result.current.slashCommandQuery).toBe('c');
    act(() => { result.current.handleTextChangeForSlash('/com', 4, '/c'); });
    expect(result.current.slashCommandQuery).toBe('com');
  });

  it('closes the picker when the user types a space (terminating the command)', () => {
    const { result } = renderHook(() => useSlashCommandAutocomplete());
    act(() => { result.current.handleTextChangeForSlash('/', 1, ''); });
    act(() => { result.current.handleTextChangeForSlash('/co', 3, '/'); });
    // Now the user types a space after, which separates the slash-token.
    // Simulate cursor moved past the space → no `/` between cursor and trigger.
    act(() => { result.current.handleTextChangeForSlash('/co foo', 7, '/co'); });
    expect(result.current.showSlashCommandPicker).toBe(false);
    expect(result.current.slashCommandQuery).toBe('');
  });
});

describe('useSlashCommandAutocomplete — selection', () => {
  function makeTextarea(): HTMLTextAreaElement {
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    return ta;
  }

  it('inserts the command + trailing space and clears the picker', () => {
    const { result } = renderHook(() => useSlashCommandAutocomplete());
    act(() => { result.current.handleTextChangeForSlash('/co', 3, ''); });

    const setPrompt = vi.fn();
    const ta = makeTextarea();
    act(() => {
      result.current.handleSlashCommandSelect(makeCommand({ full_command: '/commit' }), '/co', 3, setPrompt, ta);
    });
    expect(setPrompt).toHaveBeenCalledWith('/commit ');
    expect(result.current.showSlashCommandPicker).toBe(false);
    expect(result.current.slashCommandQuery).toBe('');
  });

  it('preserves text before "/" and after the cursor when inserting', () => {
    const { result } = renderHook(() => useSlashCommandAutocomplete());
    const setPrompt = vi.fn();
    const ta = makeTextarea();
    // Prompt: "hello /co world", cursor at 9 (just after "/co")
    act(() => {
      result.current.handleSlashCommandSelect(
        makeCommand({ full_command: '/commit' }),
        'hello /co world',
        9,
        setPrompt,
        ta,
      );
    });
    expect(setPrompt).toHaveBeenCalledWith('hello /commit  world');
  });

  it('omits afterCursor when accepts_arguments is true (cursor lands after the trailing space)', () => {
    const { result } = renderHook(() => useSlashCommandAutocomplete());
    const setPrompt = vi.fn();
    const ta = makeTextarea();
    act(() => {
      result.current.handleSlashCommandSelect(
        makeCommand({ full_command: '/echo', accepts_arguments: true }),
        '/ec rest',
        3,
        setPrompt,
        ta,
      );
    });
    // accepts_arguments drops afterCursor, leaving room for the user to type args.
    expect(setPrompt).toHaveBeenCalledWith('/echo ');
  });

  it('is a no-op when the textarea is null', () => {
    const { result } = renderHook(() => useSlashCommandAutocomplete());
    const setPrompt = vi.fn();
    act(() => {
      result.current.handleSlashCommandSelect(
        makeCommand({ full_command: '/x' }),
        '/x',
        2,
        setPrompt,
        null,
      );
    });
    expect(setPrompt).not.toHaveBeenCalled();
  });

  it('is a no-op when the cursor is not after a "/" (e.g. selection cleared the slash)', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = renderHook(() => useSlashCommandAutocomplete());
    const setPrompt = vi.fn();
    const ta = makeTextarea();
    act(() => {
      result.current.handleSlashCommandSelect(
        makeCommand({ full_command: '/x' }),
        'no slash here',
        5,
        setPrompt,
        ta,
      );
    });
    expect(setPrompt).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});

describe('useSlashCommandAutocomplete — close', () => {
  it('resets state and refocuses the textarea', () => {
    const { result } = renderHook(() => useSlashCommandAutocomplete());
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    const focusSpy = vi.spyOn(ta, 'focus');

    act(() => { result.current.handleTextChangeForSlash('/', 1, ''); });
    act(() => { result.current.handleSlashCommandPickerClose(ta); });
    expect(result.current.showSlashCommandPicker).toBe(false);
    expect(result.current.slashCommandQuery).toBe('');
    // Focus call is scheduled with setTimeout(...,0) — flush microtasks.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(focusSpy).toHaveBeenCalled();
        resolve();
      }, 5);
    });
  });

  it('does not throw when textarea is null', () => {
    const { result } = renderHook(() => useSlashCommandAutocomplete());
    expect(() => {
      act(() => { result.current.handleSlashCommandPickerClose(null); });
    }).not.toThrow();
  });
});
