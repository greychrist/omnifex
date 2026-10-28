# Modern chat format — design

2026-10-28. Greg asked for the shadcn AI Elements look (Chat, Message,
Reasoning, Chain of Thought, Prompt Input, Model Selector, Plan,
Confirmation) as a fourth chat format beside Compact, Verbose and All, named
**Modern**. The look was trialled in the `#design=ai-elements` spike page.

## Intent

Make a session read like a conversation: the user's prompt as a bubble,
Claude's prose as plain text, and the work between them — thinking and tool
calls — folded into one quiet, expandable timeline. The other three formats
are untouched; Modern is opt-in from the same toggle.

## Goals

- `ViewMode` gains `'modern'`; the format toggle shows **Modern**.
- In Modern, the transcript groups each run of thinking and tool calls into a
  **Chain of Thought** block: a muted header ("Thought, ran 3 commands, read
  1 file"), a step timeline, and each tool step expands to the existing tool
  widget, so no detail is lost.
- User prompts render as right-aligned bubbles; assistant text as borderless
  markdown; answered AskUserQuestion as a Questionnaire summary; ExitPlanMode
  as a Plan card.
- The live question card, permission card and composer take the Modern look
  while the tab is in Modern.

## Non-goals

- No change to Compact, Verbose, All, or to Appearance's per-kind styles.
- No new dependencies (AI Elements is ported onto Radix + Tailwind + our
  markdown components, as in the spike).
- Model/effort pickers stay in the status bar for now.

## Anti-goals

- Losing shown information. Any shown record Modern doesn't model renders
  exactly as in Compact (`StreamMessage compact`). Records Compact hides are
  left out of Modern entirely (Greg, 2026-10-28: no hidden-events cards); the
  other formats still show them. `thinking_tokens` is read first and shown on
  its thought ("Thought for 5s (~608 tokens)"). Notifications and the
  interrupt marker are one-line notices; a stop shows once, in red.
- Breaking navigation: prompt/step jump buttons, find-in-chat, the context
  timeline gutter and jump-to-uuid keep working.
- A slower transcript. Grouping is one linear pass over the rows Compact
  already produces; items are memoised per node identity.

## How it works

1. **Filtering** — Modern starts from `buildCompactItems(displayableMessages)`:
   the same visible/hidden decision Compact makes, so per-kind
   "hidden in compact" and "Never" settings still apply.
2. **Grouping** — `src/lib/modernGrouping.ts` (pure, tested) walks those items
   into `ModernItem`s:
   - `prompt` — a main user prompt node.
   - `work` — a maximal run of assistant thinking / tool_use nodes, their
     tool_result nodes, and hidden groups between them.
   - `text` — an assistant text node.
   - `question` — an AskUserQuestion tool_use (its result node is absorbed).
   - `plan` — an ExitPlanMode tool_use (its result node is absorbed).
   - `other` — anything else, rendered through `StreamMessage compact`, or a
     hidden group rendered through `HiddenEventsGroup`.
3. **Rendering** — `src/components/transcript-modern/` holds the ported
   primitives and `ModernTranscriptItem`. A `work` item is live (shimmering
   header, active last step) when it is the last item and the turn has
   outstanding work.
4. **Live cards** — `AgentSession` picks `ModernQuestionCard` /
   `ModernPermissionCard` in Modern. Both reuse the existing answer/rule logic
   (`buildAskUserQuestionAnswer`, `permissionCardLogic`); Codex approvals and
   symlink directory grants fall back to the existing `PermissionCard`.
5. **Composer** — `FloatingPromptInput` takes `variant="modern"`: a rounded
   input group with a round send/stop button. Behaviour is unchanged.

## Left to the builder

Exact step labels per tool, spacing, and which tools get chips vs. output
previews.
