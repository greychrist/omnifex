// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { FloatingPromptInput } from '../FloatingPromptInput';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listSupportedModels: vi.fn(async () => []),
      dropPaths: vi.fn(async () => ['/Users/g/My Docs/spec.pdf']),
      sessionPromptDraftActivity: vi.fn(async () => undefined),
    },
  };
});

afterEach(() => { cleanup(); });

describe('FloatingPromptInput — typing hint', () => {
  it("pings the session's CLI when the person types, and not without a tab", async () => {
    const { api } = await import('@/lib/api');
    const ping = vi.mocked(api.sessionPromptDraftActivity);
    ping.mockClear();
    render(<FloatingPromptInput onSend={vi.fn()} tabId="tab-typing-hint" />);
    fireEvent.change(screen.getByPlaceholderText(/Message Claude/), { target: { value: 'h' } });
    expect(ping).toHaveBeenCalledWith('tab-typing-hint');
    cleanup();
    ping.mockClear();
    render(<FloatingPromptInput onSend={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText(/Message Claude/), { target: { value: 'h' } });
    expect(ping).not.toHaveBeenCalled();
  });
});

describe('FloatingPromptInput — chat bar layout', () => {
  it('hosts no model/effort/permission pickers (they live in the session popover)', () => {
    render(<FloatingPromptInput onSend={vi.fn()} defaultModel="sonnet" />);

    expect(screen.queryByText('Sonnet')).toBeNull();
    expect(screen.queryByText('High')).toBeNull();
    expect(screen.queryByText('Default')).toBeNull();
  });

  it('keeps the output toggle in a full-width column on the left', () => {
    render(
      <FloatingPromptInput
        onSend={vi.fn()}
        outputStyleToggle={<div data-testid="output-toggle" />}
        extraMenuItems={
          <>
            <button data-testid="extra-1" />
            <button data-testid="extra-2" />
          </>
        }
      />,
    );

    const output = screen.getByTestId('output-toggle');
    expect(output.parentElement?.className).toContain('flex-col');
    expect(output.parentElement?.className).toContain('items-stretch');
    expect(output.parentElement?.className).toContain('w-40');
    expect(output.parentElement?.className).not.toContain('w-52');
    expect(screen.getByTestId('extra-1').parentElement?.className).toContain('grid-cols-3');
  });

  it('lets the input fill the bar height and pins both side stacks to the top', () => {
    render(
      <FloatingPromptInput
        onSend={vi.fn()}
        outputStyleToggle={<div data-testid="output-toggle" />}
        extraMenuItems={
          <>
            <button data-testid="extra-1" />
            <button data-testid="extra-2" />
          </>
        }
      />,
    );

    const stack = screen.getByTestId('output-toggle').parentElement!;
    const row = stack.parentElement!;
    expect(row.className).toContain('items-stretch');
    expect(row.className).not.toContain('items-end');
    expect(stack.className).toContain('self-start');
    expect(screen.getByTestId('extra-1').parentElement?.className).toContain('self-start');

    const textarea = screen.getByPlaceholderText(/Message Claude/);
    expect(textarea.className).toContain('h-full');
    expect(textarea.style.minHeight).toBe('72px');
    expect(textarea.style.height).toBe('');
  });

  it('keeps the 72px floor while empty: the placeholder must not size the bar', () => {
    // A narrow textarea wraps the placeholder onto several lines; auto-grow must
    // not read that as content height.
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 130 });
    try {
      render(<FloatingPromptInput onSend={vi.fn()} />);
      const textarea = screen.getByPlaceholderText<HTMLTextAreaElement>(/Message Claude/);
      expect(textarea.style.minHeight).toBe('72px');

      fireEvent.change(textarea, { target: { value: 'hello' } });
      expect(textarea.style.minHeight).toBe('130px');

      fireEvent.change(textarea, { target: { value: '' } });
      expect(textarea.style.minHeight).toBe('72px');
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', original);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
    }
  });
});

function stubLayout(props: Record<string, number>): () => void {
  const originals = Object.keys(props).map((k) => [k, Object.getOwnPropertyDescriptor(HTMLElement.prototype, k)] as const);
  for (const [k, v] of Object.entries(props)) {
    Object.defineProperty(HTMLElement.prototype, k, { configurable: true, get: () => v });
  }
  return () => {
    for (const [k, d] of originals) {
      if (d) Object.defineProperty(HTMLElement.prototype, k, d);
      else Reflect.deleteProperty(HTMLElement.prototype, k);
    }
  };
}

describe('FloatingPromptInput — auto-grow', () => {
  it('counts the border: a border-box min-height of bare scrollHeight clips the text by 2px', () => {
    // scrollHeight excludes the border; a border-box min-height includes it.
    const restore = stubLayout({ scrollHeight: 130, offsetHeight: 102, clientHeight: 100 });
    try {
      render(<FloatingPromptInput onSend={vi.fn()} />);
      const textarea = screen.getByPlaceholderText<HTMLTextAreaElement>(/Message Claude/);
      fireEvent.change(textarea, { target: { value: 'hello' } });
      expect(textarea.style.minHeight).toBe('132px');
    } finally {
      restore();
    }
  });

  it('does not animate its height: a transitioning min-height is shorter than the text it holds', () => {
    // A transitioning min-height lets the overflow-hidden box scroll the caret line
    // up and back.
    render(<FloatingPromptInput onSend={vi.fn()} />);
    const textarea = screen.getByPlaceholderText(/Message Claude/);
    expect(textarea.className).not.toMatch(/transition-all/);
  });

  it('returns to the 72px floor after sending', () => {
    const restore = stubLayout({ scrollHeight: 130 });
    try {
      render(<FloatingPromptInput onSend={vi.fn()} />);
      const textarea = screen.getByPlaceholderText<HTMLTextAreaElement>(/Message Claude/);
      fireEvent.change(textarea, { target: { value: 'hello' } });
      fireEvent.keyDown(textarea, { key: 'Enter' });
      expect(textarea.value).toBe('');
      expect(textarea.style.minHeight).toBe('72px');
    } finally {
      restore();
    }
  });
});

describe('FloatingPromptInput — Modern look', () => {
  it('rounds the field and the send button', () => {
    render(<FloatingPromptInput onSend={vi.fn()} />);
    expect(screen.getByPlaceholderText(/Message Claude/).className).toContain('rounded-2xl');
    expect(screen.getByPlaceholderText(/Message Claude/).closest('.modern-format')).not.toBeNull();
    const send = screen.getAllByRole('button').find((b) => b.className.includes('rounded-full'));
    expect(send).toBeDefined();
  });

});

describe('FloatingPromptInput — dropping a file', () => {
  const dropOnDocument = () => {
    const e = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'dataTransfer', {
      value: { files: [new File(['x'], 'spec.pdf', { type: 'application/pdf' })], types: ['Files'] },
    });
    act(() => { document.dispatchEvent(e); });
  };

  it('adds an @-mention of the real path to the prompt', async () => {
    render(<FloatingPromptInput onSend={vi.fn()} />);
    dropOnDocument();
    const textarea = screen.getByPlaceholderText<HTMLTextAreaElement>(/Message Claude/);
    await waitFor(() => expect(textarea.value).toBe('@"/Users/g/My Docs/spec.pdf" '));
  });

  it('leaves the prompt alone in a tab that is not showing', async () => {
    render(<FloatingPromptInput onSend={vi.fn()} isActive={false} />);
    dropOnDocument();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByPlaceholderText<HTMLTextAreaElement>(/Message Claude/).value).toBe('');
  });
});

// Teams/Outlook put a nested list on the clipboard as flat text/plain lines;
// the text/html keeps the structure.
describe('FloatingPromptInput — rich-text list paste', () => {
  const clipboard = (types: Record<string, string>) => ({
    items: [],
    getData: (t: string) => types[t] ?? '',
  });

  it('pastes a copied list as indented Markdown bullets at the caret', () => {
    render(<FloatingPromptInput onSend={vi.fn()} />);
    const textarea = screen.getByPlaceholderText<HTMLTextAreaElement>(/Message Claude/);
    fireEvent.change(textarea, { target: { value: 'Rules:\n\nthanks' } });
    textarea.setSelectionRange(8, 8);
    const notPrevented = fireEvent.paste(textarea, {
      clipboardData: clipboard({
        'text/plain': 'Parent\nEpics',
        'text/html': '<ul><li>Parent<ul><li>Epics</li></ul></li></ul>',
      }),
    });
    expect(notPrevented).toBe(false);
    expect(textarea.value).toBe('Rules:\n\n- Parent\n  - Epics\nthanks');
  });

  it('leaves a paste with no list to the browser', () => {
    render(<FloatingPromptInput onSend={vi.fn()} />);
    const textarea = screen.getByPlaceholderText<HTMLTextAreaElement>(/Message Claude/);
    const notPrevented = fireEvent.paste(textarea, {
      clipboardData: clipboard({ 'text/plain': 'const x = 1;', 'text/html': '<span>const x = 1;</span>' }),
    });
    expect(notPrevented).toBe(true);
    expect(textarea.value).toBe('');
  });
});
