# MarkdownBlock — Source/Rendered tabs on fenced markdown blocks

Status: design
Owner: Greg
Surface: `src/components/StreamMessage.tsx` and a new `src/components/MarkdownBlock.tsx`

## Problem

When Claude returns a self-contained markdown document inside an assistant
response, it commonly fences that document with `` ```markdown `` (or `` ```md ``)
so it can be quoted and copied as one unit. Today the `code()` override in both
of `StreamMessage.tsx`'s `ReactMarkdown` instances dispatches *every* fenced
block to `react-syntax-highlighter` Prism. Prism then renders that markdown
fence by syntax-highlighting the markdown **source** — so the user sees a
monospace block with colored `##`, `**`, fence markers, etc., instead of the
formatted document the markdown represents.

Two real sessions exhibit the symptom:

- WIN session `f68cfc22-a065-4ee3-b6b5-61fb316d5eeb` — final assistant message
  contains a `` ```markdown `` fence wrapping the full `pi` scaffold spec.
- An earlier scaffold session that triggered the timeline-bleed bug fix in
  `2026-05-05-card-overflow-fix` — same root cause, fenced markdown rendered
  as Prism source.

The user wants to read the formatted document by default, with the source one
click away when they need to copy or audit it.

## Solution summary

Introduce a tiny `<MarkdownBlock>` component that replaces Prism for
`language-markdown` / `language-md` fenced code blocks only. The block has
two views:

- **Rendered** (default) — runs the inner source through `ReactMarkdown` with
  the same `remarkGfm` + Prism `code()` overrides used elsewhere, inside a
  `prose` container.
- **Source** — the existing Prism `SyntaxHighlighter` with `language="markdown"`.

A two-button pill toggle lives at the top-right of the block. A copy button
sits next to it and **always copies the raw source string**, regardless of
which view is currently active. Both controls are visible at 60 % opacity so
the affordance is discoverable and brighten to 100 % on hover.

All non-markdown languages keep going to Prism exactly as today. No other
rendering paths change.

## Component

**New file** `src/components/MarkdownBlock.tsx`. Pure presentational, owns
ephemeral view state. No persistence — per-block, resets on remount.

```ts
type View = 'rendered' | 'source';

interface MarkdownBlockProps {
  /** Raw markdown source — what was inside the ```markdown fence. */
  source: string;
}
```

State:

- `view: View` — initial value `'rendered'`.

Render shape:

```tsx
<div className="relative group/mdblock my-3 rounded-md border border-border/50
                bg-muted/20 overflow-hidden">
  <div className="absolute top-1 right-1 z-10 flex items-center gap-1
                  opacity-60 group-hover/mdblock:opacity-100 transition-opacity">
    <CopyButton source={source} />
    <PillToggle value={view} onChange={setView} />
  </div>

  {view === 'rendered' ? (
    <div className="prose prose-sm dark:prose-invert max-w-none p-3 break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
        {source}
      </ReactMarkdown>
    </div>
  ) : (
    <SyntaxHighlighter
      style={syntaxTheme}
      language="markdown"
      PreTag="div"
      customStyle={{ margin: 0, padding: '0.75rem',
                     maxWidth: '100%', overflowX: 'auto' }}
    >
      {source}
    </SyntaxHighlighter>
  )}
</div>
```

`mdComponents` is the same code-override map used in `StreamMessage`'s two
existing `ReactMarkdown` call sites — extracted into a small shared module
(see "Refactor below") so `MarkdownBlock` recurses into itself when the
rendered output contains a nested `` ```markdown `` fence. Recursion depth is
bounded by the source's actual nesting; no special guard is needed.

`syntaxTheme` is the existing `getClaudeSyntaxTheme()` value already imported
by `StreamMessage`.

### Sub-components (kept inside `MarkdownBlock.tsx`)

- `<CopyButton source={source} />` — small icon-only button, copies `source`
  via `navigator.clipboard.writeText`. Inline check/copy state for ~1.2 s
  feedback. Mirrors the visual treatment of `StreamMessage.tsx`'s existing
  `CopyCardButton` (a Lucide `Copy` / `Check` icon in a rounded button), but
  is its own implementation to avoid coupling to that file's local helper.
- `<PillToggle value onChange />` — two `<button>` elements wrapped in a
  rounded border (`rounded-md border border-border/50 bg-background/80
  backdrop-blur-sm`). Each button is `text-[10px] px-2 py-0.5 font-medium`.
  Active button is `bg-foreground/10 text-foreground`; inactive is
  `text-muted-foreground hover:text-foreground`. Width is content-driven so
  labels "Rendered" / "Source" fit comfortably.

Both sub-components render `<button type="button">` with explicit
`aria-label`s and `aria-pressed` (pill) for screen readers.

## Wiring into `StreamMessage`

The same `code()` override appears twice in `StreamMessage.tsx`:

- Lines 583-601 — assistant text path
- Lines 1400-1417 — result/end-of-turn path

Both branches currently look like:

```ts
code({ node, inline, className, children, ...props }: any) {
  const match = /language-(\w+)/.exec(className || '');
  return !inline && match ? (
    <SyntaxHighlighter style={syntaxTheme} language={match[1]} PreTag="div" {...props}>
      {String(children).replace(/\n$/, '')}
    </SyntaxHighlighter>
  ) : (
    <code className={className} {...props}>{children}</code>
  );
}
```

After:

```ts
code({ node, inline, className, children, ...props }: any) {
  const match = /language-(\w+)/.exec(className || '');
  const lang = match?.[1];
  const src = String(children).replace(/\n$/, '');
  if (!inline && (lang === 'markdown' || lang === 'md')) {
    return <MarkdownBlock source={src} />;
  }
  return !inline && lang ? (
    <SyntaxHighlighter style={syntaxTheme} language={lang} PreTag="div" {...props}>
      {src}
    </SyntaxHighlighter>
  ) : (
    <code className={className} {...props}>{children}</code>
  );
}
```

### Refactor: shared `mdComponents` map

The two `code()` overrides in `StreamMessage.tsx` are byte-identical (the
"After" snippet above is the same in both call sites). To avoid duplicating
the markdown-fence dispatch logic *and* let `MarkdownBlock` reuse it, extract
the override into a small helper:

- **New file** `src/lib/markdownComponents.tsx`
  - `export const buildMarkdownComponents = (syntaxTheme: any) => ({ code: ... })` —
    returns the `components` map used by `ReactMarkdown`. Takes the theme
    because Prism style depends on the active app theme (already resolved
    via `useTheme()` in `StreamMessage`).
  - `MarkdownBlock` imports `buildMarkdownComponents` and uses it for its
    Rendered view.
  - `StreamMessage` calls `buildMarkdownComponents(syntaxTheme)` once per
    render (or memoizes on `syntaxTheme`) and passes the result to both
    `ReactMarkdown` instances.

This also eliminates the existing duplication in `StreamMessage` — net file
size goes down.

## Edge cases

- **Empty fence** (`` ```markdown\n``` ``, no body): `source = ''`. Rendered
  view shows an empty `prose` container. Source view shows an empty Prism
  block. Both are correctly empty; no special branch needed.
- **Whitespace-only source**: same as empty — no special handling.
- **Recursive `` ```markdown `` inside `` ```markdown ``**: the inner fence's
  rendered view renders another `<MarkdownBlock>`. Toggle state is per-block
  (each component instance owns its own `view` state), so the inner and
  outer toggles operate independently. No infinite loop because the source
  has finite nesting depth.
- **Language match casing**: the regex `/language-(\w+)/` already matches
  case-sensitively against the className `react-markdown` produces, which
  derives from the fence info-string verbatim. We match `'markdown'` and
  `'md'` only (lower case). `MD`, `Markdown`, `mdx` do **not** match — they
  fall through to plain Prism, preserving today's behaviour. `mdx` is a
  different format (JSX-bearing) and out of scope.
- **Card overflow chain**: `MarkdownBlock`'s outer `<div>` is `overflow-hidden`,
  so neither view can push its enclosing card wider than `w-[95%]`. The
  Source view's Prism block scrolls horizontally inside itself
  (`overflowX: 'auto'` in `customStyle`). The Rendered view's prose uses
  `break-words` so long inline `<code>` tokens wrap. Combined with the
  `overflow-x-auto` on the card body div from `2026-05-05-card-overflow-fix`,
  no MarkdownBlock content can break the timeline layout.
- **Pill state after re-render**: ephemeral, by design. If a stream update
  causes the parent `StreamMessage` to re-render with the same source,
  React reuses the `MarkdownBlock` instance and state survives. If the
  message structure changes such that the block is unmounted, state is
  legitimately lost — which is the right behaviour for an ephemeral toggle.

## Testing

TDD-required per `CLAUDE.md`. Tests written first.

**New file** `src/components/__tests__/MarkdownBlock.test.tsx`. Follows the
`ControlBar.test.tsx` template: `// @vitest-environment jsdom`,
`@testing-library/react`, `cleanup` in `afterEach`. Test cases:

1. **Default view is Rendered.**
   - Render `<MarkdownBlock source="# Heading\n\nParagraph text." />`.
   - Assert the DOM contains `<h1>Heading</h1>` (the rendered output) and
     does **not** contain a `<pre>` syntax-highlighter block.

2. **Clicking Source swaps to the Prism view.**
   - Render with the same source, `fireEvent.click(screen.getByRole('button', { name: /source/i }))`.
   - Assert a `<pre>` (or whatever Prism uses with `PreTag="div"`) containing
     the literal `# Heading` source is now in the DOM.
   - Assert `<h1>` is gone.

3. **Clicking Rendered after Source restores rendered view.**
   - Click Source then Rendered; assert `<h1>` is back.

4. **Copy button writes raw source to clipboard regardless of view.**
   - Mock `navigator.clipboard.writeText` with a vitest spy.
   - With default Rendered view: click Copy; assert spy called with the raw
     source string (including markdown syntax).
   - Switch to Source; click Copy; assert spy called again with the same
     raw source.

5. **`aria-pressed` reflects active pill.**
   - Default: `Rendered` pressed, `Source` not.
   - After click: inverted.

6. **Empty source renders without throwing.**
   - `<MarkdownBlock source="" />` mounts; both pill buttons present;
     toggling between views does not crash.

No new tests for `StreamMessage.tsx` — after the refactor below, both call
sites simply pass `buildMarkdownComponents(syntaxTheme)` to `ReactMarkdown`,
the `MarkdownBlock` unit tests cover the rendered behaviour, the
`buildMarkdownComponents` unit test covers the dispatch contract, and
`StreamMessage` has no existing render-test scaffolding (would require
setting up `MessageRenderingContext` + theme + several other providers —
disproportionate cost for the wiring change).

`buildMarkdownComponents` (the extracted helper) gets one small unit test in
`src/lib/__tests__/markdownComponents.test.tsx` that asserts the returned
`code` component dispatches a `language-markdown` block to `MarkdownBlock`
and a `language-typescript` block to `SyntaxHighlighter`. This locks in the
dispatch contract that both `ReactMarkdown` consumers depend on.

## Verification gate

- `npm run check` — TS clean across renderer + electron
- `npm run build` — Vite build clean
- `npm test` — all existing tests pass + new tests pass
- `npm run rebuild:electron` — restore native modules to NMV 145

## Files touched

| Status | Path |
|---|---|
| New | `src/components/MarkdownBlock.tsx` |
| New | `src/components/__tests__/MarkdownBlock.test.tsx` |
| New | `src/lib/markdownComponents.tsx` |
| New | `src/lib/__tests__/markdownComponents.test.tsx` |
| Edit | `src/components/StreamMessage.tsx` — replace inline `code()` overrides with `buildMarkdownComponents(syntaxTheme)` |

## Out of scope

- Tabs on user-prompt cards (currently rendered as `whitespace-pre-wrap` raw
  text). Greg confirmed this is a separable feature; if/when added, it
  should be a follow-up spec.
- `mdx` fenced blocks. Different format, JSX semantics, deferred.
- Persisting view choice across sessions. Greg picked ephemeral.
- A "view rendered" affordance for non-markdown languages (e.g. preview
  HTML). YAGNI — current scope is markdown only.
- Any change to the Prism theme, font sizes, or the broader Prism rendering
  pipeline.
