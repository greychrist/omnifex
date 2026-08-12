// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { BrainNoteViewer } from '@/components/brain/BrainNoteViewer';
import { api, type BrainNote } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    brainReadNote: vi.fn(),
    brainBacklinks: vi.fn(),
    brainUpdateNote: vi.fn(),
    brainDeleteNote: vi.fn(),
    brainListNotes: vi.fn(),
  },
}));

// MDEditor pulls in a large ESM bundle and a CodeMirror-ish surface that jsdom
// cannot drive. The editing contract under test is "what the user typed is
// what gets saved", which a textarea expresses exactly.
vi.mock('@uiw/react-md-editor', () => ({
  default: ({ value, onChange }: { value?: string; onChange?: (v?: string) => void }) => (
    <textarea
      data-testid="md-editor"
      value={value ?? ''}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}));

function note(body: string): BrainNote {
  return {
    frontmatter: {
      type: 'Subsystem', aliases: ['pty'], keywords: ['sessions'],
      created: '2026-01-01', updated: '2026-01-02', sources: ['session:abc'],
    },
    body,
  };
}

describe('BrainNoteViewer', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.mocked(api.brainReadNote).mockResolvedValue(note('## Summary\n\nthe session layer\n'));
    vi.mocked(api.brainBacklinks).mockResolvedValue([]);
    vi.mocked(api.brainListNotes).mockResolvedValue([
      'Subsystems/Sessions.md',
      'Projects/omnifex.md',
    ]);
    vi.mocked(api.brainUpdateNote).mockResolvedValue(note('rewritten'));
    vi.mocked(api.brainDeleteNote).mockResolvedValue(undefined);
  });

  it('prompts when no note is selected', () => {
    render(<BrainNoteViewer accountId={1} notePath={null} onNavigate={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.getByText(/select a note/i)).toBeTruthy();
    expect(api.brainReadNote).not.toHaveBeenCalled();
  });

  it('renders the note body', async () => {
    render(<BrainNoteViewer accountId={1} notePath="Subsystems/Sessions.md" onNavigate={vi.fn()} onChanged={vi.fn()} />);
    await waitFor(() => { expect(screen.getByText(/the session layer/)).toBeTruthy(); });
  });

  it('shows frontmatter metadata', async () => {
    render(<BrainNoteViewer accountId={1} notePath="Subsystems/Sessions.md" onNavigate={vi.fn()} onChanged={vi.fn()} />);
    await waitFor(() => { expect(screen.getByText('Subsystem')).toBeTruthy(); });
    expect(screen.getByText(/pty/)).toBeTruthy();
  });

  it('lists backlinks', async () => {
    vi.mocked(api.brainBacklinks).mockResolvedValue(['Projects/omnifex.md']);
    render(<BrainNoteViewer accountId={1} notePath="Subsystems/Sessions.md" onNavigate={vi.fn()} onChanged={vi.fn()} />);
    await waitFor(() => { expect(screen.getByRole('button', { name: 'omnifex' })).toBeTruthy(); });
  });

  it('navigates when a backlink is clicked', async () => {
    const onNavigate = vi.fn();
    vi.mocked(api.brainBacklinks).mockResolvedValue(['Projects/omnifex.md']);
    render(<BrainNoteViewer accountId={1} notePath="Subsystems/Sessions.md" onNavigate={onNavigate} onChanged={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'omnifex' }));
    expect(onNavigate).toHaveBeenCalledWith('Projects/omnifex.md');
  });

  it('navigates when a resolvable wikilink in the body is clicked', async () => {
    const onNavigate = vi.fn();
    vi.mocked(api.brainReadNote).mockResolvedValue(note('see [[omnifex]]'));
    render(<BrainNoteViewer accountId={1} notePath="Subsystems/Sessions.md" onNavigate={onNavigate} onChanged={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'omnifex' }));
    expect(onNavigate).toHaveBeenCalledWith('Projects/omnifex.md');
  });

  it('renders an unresolvable wikilink as inert text', async () => {
    vi.mocked(api.brainReadNote).mockResolvedValue(note('see [[Nonexistent]]'));
    render(<BrainNoteViewer accountId={1} notePath="Subsystems/Sessions.md" onNavigate={vi.fn()} onChanged={vi.fn()} />);

    await waitFor(() => { expect(screen.getByText(/Nonexistent/)).toBeTruthy(); });
    expect(screen.queryByRole('button', { name: 'Nonexistent' })).toBeNull();
  });

  it('saves the edited body and reports the change', async () => {
    const onChanged = vi.fn();
    render(<BrainNoteViewer accountId={1} notePath="Subsystems/Sessions.md" onNavigate={vi.fn()} onChanged={onChanged} />);

    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    fireEvent.change(screen.getByTestId('md-editor'), { target: { value: 'my new body' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => { expect(api.brainUpdateNote).toHaveBeenCalled(); });
    expect(api.brainUpdateNote).toHaveBeenCalledWith(1, 'Subsystems/Sessions.md', 'my new body');
    await waitFor(() => { expect(onChanged).toHaveBeenCalled(); });
  });

  it('discards edits on cancel without writing', async () => {
    render(<BrainNoteViewer accountId={1} notePath="Subsystems/Sessions.md" onNavigate={vi.fn()} onChanged={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    fireEvent.change(screen.getByTestId('md-editor'), { target: { value: 'throwaway' } });
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(api.brainUpdateNote).not.toHaveBeenCalled();
    await waitFor(() => { expect(screen.getByText(/the session layer/)).toBeTruthy(); });
  });

  it('surfaces a save failure instead of appearing to succeed', async () => {
    vi.mocked(api.brainUpdateNote).mockRejectedValue(new Error('disk full'));
    const onChanged = vi.fn();
    render(<BrainNoteViewer accountId={1} notePath="Subsystems/Sessions.md" onNavigate={vi.fn()} onChanged={onChanged} />);

    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => { expect(screen.getByText(/disk full/)).toBeTruthy(); });
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('does not delete without confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<BrainNoteViewer accountId={1} notePath="Subsystems/Sessions.md" onNavigate={vi.fn()} onChanged={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /delete/i }));
    expect(api.brainDeleteNote).not.toHaveBeenCalled();
  });

  it('deletes after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onChanged = vi.fn();
    render(<BrainNoteViewer accountId={1} notePath="Subsystems/Sessions.md" onNavigate={vi.fn()} onChanged={onChanged} />);

    fireEvent.click(await screen.findByRole('button', { name: /delete/i }));
    await waitFor(() => {
      expect(api.brainDeleteNote).toHaveBeenCalledWith(1, 'Subsystems/Sessions.md');
    });
    expect(onChanged).toHaveBeenCalled();
  });

  it('surfaces a read failure rather than an empty note', async () => {
    vi.mocked(api.brainReadNote).mockRejectedValue(new Error('cannot read note: bad frontmatter'));
    render(<BrainNoteViewer accountId={1} notePath="Subsystems/Broken.md" onNavigate={vi.fn()} onChanged={vi.fn()} />);
    await waitFor(() => { expect(screen.getByText(/bad frontmatter/)).toBeTruthy(); });
  });

  it('reloads when the selected note changes', async () => {
    const { rerender } = render(
      <BrainNoteViewer accountId={1} notePath="Subsystems/Sessions.md" onNavigate={vi.fn()} onChanged={vi.fn()} />,
    );
    await waitFor(() => { expect(api.brainReadNote).toHaveBeenCalledWith(1, 'Subsystems/Sessions.md'); });

    rerender(<BrainNoteViewer accountId={1} notePath="Projects/omnifex.md" onNavigate={vi.fn()} onChanged={vi.fn()} />);
    await waitFor(() => { expect(api.brainReadNote).toHaveBeenCalledWith(1, 'Projects/omnifex.md'); });
  });

  it('leaves edit mode when the selected note changes', async () => {
    const { rerender } = render(
      <BrainNoteViewer accountId={1} notePath="Subsystems/Sessions.md" onNavigate={vi.fn()} onChanged={vi.fn()} />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    expect(screen.getByTestId('md-editor')).toBeTruthy();

    // An open editor carrying one note's draft into another note's path is a
    // save that silently overwrites the wrong file.
    rerender(<BrainNoteViewer accountId={1} notePath="Projects/omnifex.md" onNavigate={vi.fn()} onChanged={vi.fn()} />);
    await waitFor(() => { expect(screen.queryByTestId('md-editor')).toBeNull(); });
  });
});
