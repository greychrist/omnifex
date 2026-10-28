# Modern chat format — plan

Spec: `docs/superpowers/specs/2026-10-28-modern-chat-format-design.md`.
Branch: `feat/modern-chat-format` (from `main`; the spike branch is dropped).

1. **ViewMode** — add `'modern'` to `ViewMode` and the toggle; `showsGutterDelta`
   treats Modern like Compact. Test: toggle renders four buttons; gutter rule.
2. **Grouping** — `src/lib/modernGrouping.ts` + `src/lib/__tests__/modernGrouping.test.ts`
   (TDD): prompts, work runs (thinking, tool_use, tool_result, hidden groups),
   text, question/plan absorbing their results, `other` passthrough, keys
   stable across appends.
3. **Step labels** — `src/lib/modernSteps.ts` (TDD): tool_use → label, chips,
   output preview, diff, status from the paired result.
4. **Primitives** — move the spike's `aiElements.tsx` into
   `src/components/transcript-modern/`, split by component.
5. **Renderer** — `ModernTranscriptItem` + the `'modern'` branch in
   `ClaudeTranscript`, keeping row anchors, timeline gutter and jump targets.
   Test: renders a prompt bubble, a chain of thought, text, passthrough.
6. **Live cards** — extract `buildAskUserQuestionAnswer` from
   `AskUserQuestionCard` (TDD), build `ModernQuestionCard` and
   `ModernPermissionCard` on the shared logic, choose them in `AgentSession`.
7. **Composer** — `FloatingPromptInput variant="modern"`.
8. **Remove the spike** (done before step 1: the spike branch was deleted) — `src/components/design-preview/` and the
   `#design=` hash route.
9. **Verify** — `verify.sh`; commit on the branch.
