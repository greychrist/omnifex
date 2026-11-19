# Standard and Expanded Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four chat formats with one Modern renderer and two views (Standard, Expanded), delete the classic renderer, and cut Settings › Chats down to what Modern uses.

**Architecture:** The transcript pipeline is pulled into one pure function (`transcriptItems`) and pinned by a golden test before anything changes, so "Standard shows exactly what Modern shows today" is checked mechanically. Every record then gets a Modern drawing, the view switch drops to two values, the classic renderer is deleted, and the config moves to v6 with a migration that rewrites per-kind visibility from Modern's effective behavior.

**Tech Stack:** React 19, TypeScript, Tailwind v4, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-18-standard-expanded-views-design.md`

## Global Constraints

- Standard shows exactly what Modern shows today, for every saved config; per-kind settings are rewritten from Modern's current effective visibility, not from the old labels.
- `ViewMode` is `"standard" | "expanded"`; default `"standard"`. Saved `compact`/`modern` → `standard`, `verbose`/`all` → `expanded`.
- Expanded skips `filterDisplayableMessages`, `collapseRepeats` and per-kind visibility; it still folds tool runs into work. Not shown: frames that never enter `messages[]`, and post-compact copies dropped by `repeatedRecords.ts`.
- Per kind and per category: icon, color, Show in Standard. Nothing else.
- Context rail: Standard hides sub-2k deltas; Expanded prints every delta.
- TDD; the repo's American-spelling guard; renderer-only (no daemon or IPC change).
- Refactors delete what they make unreachable in the same task (root CLAUDE.md).
- No worktree; work on branch `feat/standard-expanded-views` in the main checkout.

## Review Focus

1. A saved v5 config with `modern.recordRules: "verbose"` or `"all"` — Standard after migration must show the same records it showed under those rules. Test: Task 5, `migrates recordRules verbose and all`.
2. A kind whose visibility was set at the category level only (Greg: system, live = `verbose`) — the migration must write `standard: false` on the category, not on each kind, so a kind that overrides stays overridden. Test: Task 5, `writes standard at the level it was set`.
3. A transcript record of a type no registry kind covers — Expanded must draw it as the amber "Unrecognized record" line, never drop it. Test: Task 2, `draws an unregistered record as an unrecognized line`.
4. A session open while settings are still loading — opens in `standard`, takes the saved default when it lands (`useSessionViewMode`). Test: Task 3, `opens in standard before settings load`.
5. A garbage or pre-v5 saved config — loads as defaults without throwing. Test: Task 5, `resets anything that is not v5 or v6`.

---

### Task 1: One pipeline function, pinned by a golden test

**Files:**
- Create: `src/lib/transcriptItems.ts`
- Create: `src/lib/__tests__/fixtures/allKindRecords.ts`
- Create: `src/lib/__tests__/fixtures/gregRenderingConfig.ts`
- Create: `src/lib/__tests__/standardVisibility.golden.test.ts` (+ its committed `__snapshots__`)
- Modify: `src/components/claude/ClaudeTranscript.tsx:173-292` (call `transcriptItems` for the Modern path)

**Interfaces:**
- Produces: `transcriptItems(messages: JsonlNode[], config: MessageRenderingConfig, viewMode: ViewMode): ModernItem[]` — today's Modern pipeline exactly: `rulesViewMode`, `revealNeverShown` when rules are `all`, `collapseRepeats` → `filterDisplayableMessages` → `withoutNeverShown` → `buildModernItems(displayable, config, messages, config.modern.recordRules)`.
- Produces: `ALL_KIND_RECORDS: JsonlNode[]` — at least one classified record per `KIND_REGISTRY` id that a persisted or live record can produce, plus one record of an unregistered `type`, in one plausible transcript order (prompt, work, answer…), every record with a unique `uuid`.
- Produces: `GREG_RENDERING_CONFIG: unknown` — the saved v5 JSON (version, defaultViewMode `modern`, categories, kinds, `modern.recordRules: "compact"`), copied from `app_settings.message_rendering_config`.
- Produces: `drawnUuids(items: ModernItem[]): string[]` (test helper in the golden file) — every node uuid an item draws, work entries included, in order.

- [ ] **Step 1: Write the fixture coverage test**

```ts
it('covers every registry kind a record can produce', () => {
  const covered = new Set(ALL_KIND_RECORDS.map((n) => classifyStandaloneKind(n, ALL_KIND_RECORDS) ?? 'unknown'));
  const missing = Object.keys(KIND_REGISTRY).filter((id) => !covered.has(id) && !NOT_A_RECORD.has(id));
  expect(missing).toEqual([]);
});
```
`NOT_A_RECORD` lists, with a one-line reason each, kinds no record classifies to (live-only UI kinds such as `assistant.text.live`, `permission.request` if it is never a transcript record).

- [ ] **Step 2: Write the golden test**

Four cases, each `expect(drawnUuids(transcriptItems(ALL_KIND_RECORDS, cfg, 'modern'))).toMatchSnapshot()`: default config with `recordRules` `compact`, `verbose`, `all`; `mergeConfig(GREG_RENDERING_CONFIG)`.

- [ ] **Step 3: Run; the coverage test fails until the fixture is complete, then the snapshot is written**

Run: `npx vitest run src/lib/__tests__/standardVisibility.golden.test.ts`
Expected: PASS, snapshot file created.

- [ ] **Step 4: Point ClaudeTranscript's Modern path at `transcriptItems`**; behavior unchanged.

Run: `npx vitest run src/components src/lib` — Expected: PASS.

- [ ] **Step 5: Commit** — `test(transcript): pin what Modern draws with a golden test`

From here on the snapshot file is never updated with `-u`. A task that changes it has changed what Standard shows.

---

### Task 2: Every record gets a Modern line

**Files:**
- Modify: `src/lib/modernLines.ts` (`modernLineOf`)
- Modify: `src/lib/modernGrouping.ts:74-96,421-428` (remove the `other` item)
- Modify: `src/components/transcript-modern/ModernTranscriptItem.tsx:164-175` (remove the `other` case and the `StreamMessage` import)
- Modify: `src/components/transcript-modern/RecordLine.tsx` (kind color accent)
- Test: `src/lib/__tests__/modernLines.test.ts`, `src/lib/__tests__/modernGrouping.test.ts`

**Interfaces:**
- Consumes: `ALL_KIND_RECORDS` (Task 1).
- Produces: `modernLineOf(node, messages, config): ModernLine | null` — null only for `raw.type` `permission_request` and `summary`. `ModernItem` no longer has `kind: 'other'`.
- Produces: `LineAccent` gains no new variant; a kind's color is `{ kind: 'css', color: resolveKind(config, kindId).accentColor }`, used when the line has no accent of its own (permission, effort and model lines keep theirs).

- [ ] **Step 1: Write the failing tests**

```ts
it('leaves no record to the classic card', () => {
  const items = buildModernItems(ALL_KIND_RECORDS, revealNeverShown(createDefaultConfig()), ALL_KIND_RECORDS, 'all');
  expect(items.filter((i) => (i as { kind: string }).kind === 'other')).toEqual([]);
});

it.each(['user.subagentPrompt', 'user.skillInjection', 'user.systemContext', 'user.taskNotification',
  'user.coordinatorMessage', 'user.sdkSystemBracket'])('draws %s as a line in its kind icon and color', (kindId) => {
  const node = recordOfKind(kindId); // from ALL_KIND_RECORDS
  const cfg = createDefaultConfig();
  const line = modernLineOf(node, ALL_KIND_RECORDS, cfg)!;
  expect(line.icon).toBe(resolveKind(cfg, kindId).icon);
  expect(line.accent).toEqual({ kind: 'css', color: resolveKind(cfg, kindId).accentColor });
  expect(line.body?.length).toBeGreaterThan(0);
  expect(line.fold).toBe(true);
});

it('draws an unregistered record as an unrecognized line', () => {
  const line = modernLineOf(classifyJsonlLine({ type: 'brand_new', uuid: 'x' })!, [], createDefaultConfig())!;
  expect(line.title).toBe('Unrecognized record: brand_new');
  expect(line.tone).toBe('warn');
});
```
Plus one test for a tool result that is not inside a work run (title from the tool name, body = result text, folded).

- [ ] **Step 2: Run; expect FAIL** — `npx vitest run src/lib/__tests__/modernLines.test.ts src/lib/__tests__/modernGrouping.test.ts`

- [ ] **Step 3: Implement.** Title = `KIND_REGISTRY[kindId].label` unless the record carries a better one; body text via `recordText.ts` where it has a function, else the record's text blocks, else `JSON.stringify(raw, null, 2)` with `mono: true`; long bodies fold. Delete the `other` variant and every branch that handled it.

- [ ] **Step 4: Run** `npx vitest run src/lib src/components/transcript-modern` and the golden test — Expected: PASS, snapshot unchanged.

- [ ] **Step 5: Commit** — `feat(modern): draw every record as a Modern line`

---

### Task 3: Two views

**Files:**
- Modify: `src/lib/messageRenderingConfig.ts:880-892,1058-1060` (`ViewMode`, `VIEW_MODES`, `rulesViewMode` removed, `defaultViewMode` migration)
- Modify: `src/lib/transcriptItems.ts` (Standard / Expanded)
- Modify: `src/components/SessionViewToggle.tsx`, `src/hooks/useSessionViewMode.ts`, `src/components/settings-panels/GeneralSettings.tsx:75-330`
- Modify: `src/components/claude/ClaudeTranscript.tsx` (Modern only: drop every `viewMode === 'compact' | 'modern'` branch; always `modern-format`; `ModernLiveAnswer`)
- Modify: `src/components/AgentSession.tsx:1111-1112,3219` (always the Modern question and permission cards)
- Modify: `src/lib/contextTimeline.ts` (`showsGutterDelta`), `src/lib/collapseRepeats.ts` (`onlyIn` values)
- Test: the files' existing tests, plus `src/lib/__tests__/transcriptItems.test.ts`

**Interfaces:**
- Produces: `type ViewMode = 'standard' | 'expanded'`; `transcriptItems(messages, config, viewMode)`: `standard` = Task 1's pipeline with `recordRules: 'compact'`-equivalent rules taken from config (until Task 5 moves them into per-kind `standard`); `expanded` = `buildModernItems(messages, config, messages, 'all')` with no filtering at all (a `buildModernItems` option `hideNothing: true`, or equivalent, so `hidden()` returns false).
- Produces: `CollapseRule.onlyIn?: ViewMode[]` with the new values; rules that applied in Compact/Modern apply in `standard`, rules that applied in All apply in `expanded`.

- [ ] **Step 1: Write the failing tests**
  - golden test driver switches to `transcriptItems(..., 'standard')` for the four cases — snapshot must still match.
  - `expanded draws every record`: `drawnUuids(transcriptItems(ALL_KIND_RECORDS, cfg, 'expanded'))` contains every uuid in `ALL_KIND_RECORDS`, for default and Greg's config.
  - `expanded still folds tool runs`: a prompt, two tool calls with results, an answer → items `['prompt', 'work', 'text']`.
  - `migrates the default view`: `mergeConfig({...v5, defaultViewMode: m}).defaultViewMode` is `standard` for `compact`, `modern`; `expanded` for `verbose`, `all`; `standard` for garbage.
  - `opens in standard before settings load` (`useSessionViewMode`).
  - `showsGutterDelta(1_500, 'standard') === false`, `showsGutterDelta(1_500, 'expanded') === true`.
  - `SessionViewToggle` renders exactly two buttons, `Standard` and `Expanded`.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.** Toggle titles: Standard — "The conversation: prompts, answers, and the work between them folded away"; Expanded — "Every record in the transcript, drawn the same way". The 2×2 grid becomes one row of two.
- [ ] **Step 4: Run** `npm run check` and `npx vitest run` — Expected: PASS, golden snapshot unchanged.
- [ ] **Step 5: Commit** — `feat(chat): Standard and Expanded replace the four chat formats`

---

### Task 4: Delete the classic renderer

**Files:**
- Delete: `src/components/StreamMessage.tsx`, `src/components/StreamMessage/` (except `RawJsonPopover`, which moves to `src/components/transcript-modern/RawJsonPopover.tsx`), `src/components/HiddenEventsGroup.tsx`, `src/lib/hiddenEventsSummary.ts`, `src/components/InflightAssistantBubble.tsx`, `InflightThinking`, `src/components/KindHeader.tsx`, `src/components/CardActionBar.tsx`, the classic `AskUserQuestionCard` / `PermissionCard` if Task 3 left them unreferenced, `src/components/settings-panels/appearance/{SamplePreview,TurnPreview,AllCardsEditor,HiddenEventsEditor}.tsx`, the classic tool widgets under `src/components/claude/tools/` and `src/components/ToolWidgets.tsx` that nothing left imports, and their tests.
- Modify: `src/lib/compactGrouping.ts` → keep only what Modern uses (`isMessageFullyHidden`, `withoutNeverShown`), moved into `src/lib/transcriptItems.ts`; delete the file.
- Modify: `src/components/settings-panels/AppearanceSettings.tsx` (drop the Turn preview tab and the All cards / Hidden events sections; Task 5 brings back a Modern preview)
- Modify: `src/lib/typographyClasses.ts`, `src/lib/accentStyle.ts` (drop classic-only exports)

**Interfaces:**
- Consumes: Task 3 (nothing renders classic rows).
- Produces: no new names. `RawJsonPopover` import path changes to `@/components/transcript-modern/RawJsonPopover`.

- [ ] **Step 1: Find what is unreachable.** For each candidate file, `grep -rln "<module name>" src | grep -v __tests__` after removing `StreamMessage`'s importers; a file is deleted only when nothing outside the deletion set imports it. Record the final list in the commit body.
- [ ] **Step 2: Delete, then run** `npm run check` — Expected: PASS (a failure names a file still in use: keep it or move what it needs).
- [ ] **Step 3: Run** `npx vitest run` — Expected: PASS, golden snapshot unchanged.
- [ ] **Step 4: Run** `npm run build` — Expected: PASS.
- [ ] **Step 5: Commit** — `refactor(chat): delete the classic renderer`

---

### Task 5: Config v6, migration, and the new Settings › Chats

**Files:**
- Modify: `src/lib/messageRenderingConfig.ts` (types, defaults, `mergeConfig`, `KIND_REGISTRY` defaults)
- Create: `src/lib/renderingConfigMigration.ts` (`migrateV5`)
- Create: `src/components/settings-panels/appearance/MessagesEditor.tsx` (the merged tab), `ModernTurnPreview.tsx`
- Modify: `src/components/settings-panels/AppearanceSettings.tsx` (tabs: Messages, Turn preview, Typography), `MessageKindTree.tsx`, `KindEditor.tsx` (three controls), `TypographyEditor.tsx` (content only), `ModernEditor.tsx` (folded into `MessagesEditor`; delete the file and the "Show records like" control)
- Modify: `src/lib/transcriptItems.ts`, `src/lib/modernGrouping.ts` (Standard reads `standard`)
- Test: `src/lib/__tests__/renderingConfigMigration.test.ts`, `messageRenderingConfig.test.ts`, the settings panel tests

**Interfaces:**
- Produces: `KindStyle = { accentColor: string; icon: IconName; standard: boolean; alwaysShown?: boolean }` (`alwaysShown` replaces `compactBoundaryLocked`); `CategoryStyle extends KindStyle { label; description }`; `MessageRenderingConfig.version: 6`, without `hiddenEvents`, `cardBorderOpacity`, `cardBorderRadius`, `typography.header`, `typography.icon`, `modern.recordRules`.
- Produces: `isHiddenInStandard(style: KindStyle): boolean` = `!style.alwaysShown && !style.standard` (replaces `isHiddenInCompact`, `isNeverShown`, `revealNeverShown`).
- Produces: `migrateV5(saved: Record<string, unknown>): Record<string, unknown>` — v5 record in, v6-shaped record out, consumed by `mergeConfig`. Rule, per layer (category, registry default, user kind patch) where `visibility` is set: `standard = recordRules === 'all' || visibility === 'always' || (recordRules === 'verbose' && visibility === 'verbose')`, written at the same layer; registry defaults become `standard` booleans in code.
- Produces: `MessagesEditor({ config, onChange })`, `ModernTurnPreview({ config, viewMode })` — the preview renders `transcriptItems(PREVIEW_TURN, config, viewMode)` through `ModernTranscriptItem`.

- [ ] **Step 1: Write the failing tests**
  - golden test driver switches to `transcriptItems(..., 'standard')` over `mergeConfig(<v5 case>)` — all four snapshots unchanged.
  - `migrates recordRules verbose and all`: same as above for those cases (part of the golden).
  - `writes standard at the level it was set`: Greg's config → `categories.system.standard === false`, `kinds['custom-title'].standard === true`, `kinds['queue-operation'].standard === false`, no `standard` key added to kinds that had no `visibility`.
  - `resets anything that is not v5 or v6`: `mergeConfig(null)`, `mergeConfig({version: 4})`, `mergeConfig('x')` equal `createDefaultConfig()`.
  - `round-trips v6`: `parseConfig(serializeConfig(cfg))` equals `cfg`.
  - Settings: the Chats panel has tabs `Messages`, `Turn preview`, `Typography` in that order, `Messages` selected by default; a kind row has exactly an icon picker, a color picker and a `Show in Standard` switch; kinds Modern draws with its own items (prompt, answers, thinking, tool calls, tool results in work, answered questions, plans) are not in the tree; toggling a kind's switch changes `ModernTurnPreview` in Standard.
- [ ] **Step 2: Run; expect FAIL.**
- [ ] **Step 3: Implement.** Old sessionStorage tab key values (`kinds`, `modern`, `turns`, `typography`) map to `messages`, `messages`, `turns`, `typography`.
- [ ] **Step 4: Run** `npm run check`, `npx vitest run`, `npm run build` — Expected: PASS, golden snapshot unchanged.
- [ ] **Step 5: Commit** — `feat(settings): one Messages tab for the Modern format; config v6`

---

### Task 6: Docs, verification, hand-off

**Files:**
- Modify: `README.md` (chat formats → Standard / Expanded; Settings › Chats), `CHANGELOG.md` is the release's job — not here.
- Modify: `docs/superpowers/specs/2026-10-28-modern-chat-format-design.md` (one line at top: superseded by the 2026-11-18 spec)

- [ ] **Step 1:** `grep -rn "Compact\|Verbose\|compactBoundaryLocked\|recordRules\|StreamMessage" src docs/*.md README.md CLAUDE.md src/CLAUDE.md` — every hit is either history in a dated spec or fixed.
- [ ] **Step 2:** Run `/verify` (full gate: check, build, test:coverage, Swift) — Expected: PASS.
- [ ] **Step 3:** `npm run package`; Greg opens a long session in the packaged app and, with `__omnifexProfile.on()`, compares a tab switch against 0.5.50. Do not launch it for him.
- [ ] **Step 4: Commit** — `docs: Standard and Expanded views`
