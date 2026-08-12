import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import MDEditor from '@uiw/react-md-editor';
import { Loader2, Pencil, Save, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, type BrainNote } from '@/lib/api';
import {
  noteTitle,
  resolveWikilink,
  wikilinkTarget,
  wikilinksToMarkdown,
  WIKILINK_SCHEME,
} from '@/lib/brainWikilinks';

/**
 * react-markdown strips any URL whose scheme is not on its allow-list, which
 * includes the scheme wikilinks are smuggled through — so without this every
 * wikilink arrives at the link renderer with an empty href and degrades to
 * inert text. Only OUR scheme is exempted; everything else still goes through
 * the library's own sanitizer, so a `javascript:` URL in a hand-edited note
 * is neutralised exactly as before.
 */
function wikilinkUrlTransform(url: string): string {
  return url.startsWith(WIKILINK_SCHEME) ? url : (defaultUrlTransform(url) || '');
}

interface BrainNoteViewerProps {
  accountId: number | null;
  notePath: string | null;
  onNavigate: (notePath: string) => void;
  onChanged: () => Promise<void> | void;
}

/**
 * One note: its frontmatter, its rendered body with live wikilinks, the notes
 * that link back to it, and an editor.
 *
 * Editing goes through `brainUpdateNote`, which replaces only the BODY — the
 * renderer never sends frontmatter. A note's type, provenance and sources are
 * what merge dedup relies on later, so an edit box that could rewrite them
 * would make them untrustworthy.
 */
export const BrainNoteViewer: React.FC<BrainNoteViewerProps> = ({
  accountId, notePath, onNavigate, onChanged,
}) => {
  const [note, setNote] = useState<BrainNote | null>(null);
  const [backlinks, setBacklinks] = useState<string[]>([]);
  const [allNotes, setAllNotes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /** Same discipline as useBrainVault: a late response for a note the user has
   *  already navigated away from must not replace the current one. */
  const loadToken = useRef(0);

  useEffect(() => {
    const token = ++loadToken.current;
    // A draft belongs to the note it was opened on. Carrying it across a
    // navigation would let a save write one note's text to another's path.
    setDraft(null);
    setError(null);

    if (accountId === null || notePath === null) {
      setNote(null);
      setBacklinks([]);
      return;
    }

    setLoading(true);
    Promise.all([
      api.brainReadNote(accountId, notePath),
      api.brainBacklinks(accountId, notePath),
      api.brainListNotes(accountId),
    ])
      .then(([loaded, links, paths]) => {
        if (loadToken.current !== token) return;
        setNote(loaded);
        setBacklinks(links);
        setAllNotes(paths);
      })
      .catch((err: unknown) => {
        if (loadToken.current !== token) return;
        setError((err as Error).message);
        setNote(null);
        setBacklinks([]);
      })
      .finally(() => {
        if (loadToken.current === token) setLoading(false);
      });
  }, [accountId, notePath]);

  const handleLink = useCallback(
    (target: string): void => {
      const resolved = resolveWikilink(target, allNotes);
      if (resolved !== null) onNavigate(resolved);
    },
    [allNotes, onNavigate],
  );

  // A wikilink becomes a button only when it resolves to exactly one note.
  // An unresolvable or ambiguous target renders as plain text: a dead button
  // that silently does nothing, or one that opens a note the author did not
  // mean, are both worse than visibly inert text.
  const markdownComponents = useMemo(
    () => ({
      a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
        const target = wikilinkTarget(href);
        if (target === null) {
          return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
        }
        if (resolveWikilink(target, allNotes) === null) {
          return <span className="text-muted-foreground underline decoration-dotted">{children}</span>;
        }
        return (
          <button
            type="button"
            onClick={() => { handleLink(target); }}
            className="text-primary underline underline-offset-2"
          >
            {children}
          </button>
        );
      },
    }),
    [allNotes, handleLink],
  );

  const save = (): void => {
    if (accountId === null || notePath === null || draft === null) return;
    setSaving(true);
    setError(null);
    api
      .brainUpdateNote(accountId, notePath, draft)
      .then(async (updated) => {
        setNote(updated);
        setDraft(null);
        await onChanged();
      })
      .catch((err: unknown) => { setError((err as Error).message); })
      .finally(() => { setSaving(false); });
  };

  const remove = (): void => {
    if (accountId === null || notePath === null) return;
    if (!window.confirm(`Delete "${noteTitle(notePath)}"? This cannot be undone from OmniFex.`)) {
      return;
    }
    api
      .brainDeleteNote(accountId, notePath)
      .then(async () => { await onChanged(); })
      .catch((err: unknown) => { setError((err as Error).message); });
  };

  if (notePath === null) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-xs text-muted-foreground">Select a note to read it.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b px-4 py-2">
        <h3 className="truncate text-sm font-medium">{noteTitle(notePath)}</h3>
        <div className="ml-auto flex items-center gap-1">
          {draft === null ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={note === null}
                onClick={() => { setDraft(note?.body ?? ''); }}
              >
                <Pencil className="mr-1.5 h-3.5 w-3.5" />
                Edit
              </Button>
              <Button size="sm" variant="ghost" onClick={remove}>
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                Delete
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" onClick={save} disabled={saving}>
                {saving
                  ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  : <Save className="mr-1.5 h-3.5 w-3.5" />}
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setDraft(null); }}>
                <X className="mr-1.5 h-3.5 w-3.5" />
                Cancel
              </Button>
            </>
          )}
        </div>
      </header>

      {error !== null && (
        <p className="border-b bg-destructive/10 px-4 py-2 text-xs text-destructive">{error}</p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {loading && note === null && (
          <p className="text-xs text-muted-foreground">Loading…</p>
        )}

        {note !== null && draft === null && (
          <>
            <dl className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-b pb-3 text-[11px] text-muted-foreground">
              <span>{note.frontmatter.type}</span>
              <span>updated {note.frontmatter.updated}</span>
              {note.frontmatter.aliases.length > 0 && (
                <span>aliases: {note.frontmatter.aliases.join(', ')}</span>
              )}
              {note.frontmatter.keywords.length > 0 && (
                <span>keywords: {note.frontmatter.keywords.join(', ')}</span>
              )}
            </dl>

            <div className="prose prose-sm max-w-none dark:prose-invert">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={markdownComponents}
                urlTransform={wikilinkUrlTransform}
              >
                {wikilinksToMarkdown(note.body)}
              </ReactMarkdown>
            </div>

            <section className="mt-6 border-t pt-3">
              <h4 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Linked from
              </h4>
              {backlinks.length === 0 ? (
                <p className="text-xs text-muted-foreground">Nothing links here yet.</p>
              ) : (
                <ul className="space-y-0.5">
                  {backlinks.map((path) => (
                    <li key={path}>
                      <button
                        type="button"
                        onClick={() => { onNavigate(path); }}
                        className="text-xs text-primary underline underline-offset-2"
                      >
                        {noteTitle(path)}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}

        {draft !== null && (
          <MDEditor
            value={draft}
            onChange={(v) => { setDraft(v ?? ''); }}
            height={480}
            preview="edit"
          />
        )}
      </div>
    </div>
  );
};

export default BrainNoteViewer;
