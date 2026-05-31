# Message-rendering id-keyed registry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-message match-engine styling model with a single id-keyed kind registry, so each message styles itself by its classifier id through one pure `resolveKind` lookup.

**Architecture:** A code-level `KIND_REGISTRY` (id → category + label + default chrome) is the source of truth. `resolveKind(config, id)` merges three layers by plain id lookup: category theme → registry default → sparse user patch (`config.kinds[id]`). The general `path/op/value` match engine, per-message cascade, `effConfig` injection, and the override-rule editor UI are deleted. Saved configs reset to fresh v5 defaults.

**Tech Stack:** React 18 + TypeScript + Tailwind v4 (renderer), Vitest. Renderer-only change; no Electron/IPC surface touched.

**Reference spec:** `docs/superpowers/specs/2026-05-31-message-kind-registry-redesign-design.md`

**Branch:** create `redesign/message-kind-registry` off the current checkout before Task 1.

```bash
git checkout -b redesign/message-kind-registry
```

---

## Notes for the implementer

- All paths are relative to `/Users/gregorychristie/Repos/personal/omnifex`.
- Renderer source lives under `src/`. Tests live next to code under `src/lib/__tests__/` and `src/components/**/__tests__/`.
- Run a single test file with: `npx vitest run <path>`. Run all: `npm test`. Typecheck: `npm run check`. Build: `npm run build`.
- TDD: write the failing test, run it red, implement, run it green, commit.
- After the full vitest run at the end, run `npm run rebuild:electron` (the app's native module must be rebuilt for Electron before Greg restarts the app).
- This refactor deletes exported symbols. The TypeScript compiler (`npm run check`) is your safety net for finding every call site — run it often.

### Symbols being DELETED from `src/lib/messageRenderingConfig.ts`
`Override`, `MatchCondition`, `MatchOp`, `resolveMessageStyle`, `conditionsMatch`, `getByPath`, `valuesForPath`, `valueSatisfies`, `withResolvedKindStyle`, `pruneRedundantOverrides`, `kindOverride`, `upsertKindOverride`, `KNOWN_KIND_IDS`, `DEFAULT_OVERRIDES`, `originOf` (replaced by `categoryOf`).

### Symbols being DELETED from `src/lib/accentStyle.ts`
`resolvedAccentFor`, `resolvedAccentStyleFor`, `resolvedSwatchFor`. The remaining `accentFor`/`accentStyleFor`/`swatchFor` become cascade-aware automatically because `resolveKind` now folds in the per-kind style.

### Files to DELETE outright
- `src/components/settings-panels/appearance/OverrideMatchDialog.tsx`
- `src/components/settings-panels/appearance/MatchingRules.tsx`
- `src/components/settings-panels/appearance/matchFormat.ts` (match-condition formatting — only used by the dialog/MatchingRules)
- `src/components/settings-panels/appearance/__tests__/OverrideMatchDialog.test.tsx`
- `src/lib/__tests__/messageMatch.test.ts` (the match-engine tests; `messageMatch.ts` itself stays — it only re-exports `classifyStandaloneKind`)

Run `npm run check` after the deletions in D1 and let the compiler list any remaining importers of these files; fix each as you go.

---

## Phase A — Core library: registry + resolver + v5 config

### Task A1: Add the `Category` reduction + `KindDef`/`KIND_REGISTRY` types

**Files:**
- Modify: `src/lib/messageRenderingConfig.ts`
- Test: `src/lib/__tests__/messageRenderingConfig.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/lib/__tests__/messageRenderingConfig.test.ts`:

```ts
import { CATEGORIES, KIND_REGISTRY, categoryOf } from "@/lib/messageRenderingConfig";

describe("kind registry", () => {
  it("has exactly the three real categories", () => {
    expect([...CATEGORIES]).toEqual(["user", "agent", "system"]);
  });

  it("registers every catalog kind under a real category", () => {
    for (const [id, def] of Object.entries(KIND_REGISTRY)) {
      expect(def.id).toBe(id);
      expect(CATEGORIES).toContain(def.category);
    }
  });

  it("categoryOf returns the registry category, falling back to system", () => {
    expect(categoryOf("permission.request")).toBe("system");
    expect(categoryOf("assistant.text")).toBe("agent");
    expect(categoryOf("user.prompt")).toBe("user");
    expect(categoryOf("totally.unknown.future.id")).toBe("system");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/messageRenderingConfig.test.ts`
Expected: FAIL — `KIND_REGISTRY`/`categoryOf` not exported, `CATEGORIES` still has 5 entries.

- [ ] **Step 3: Implement the registry and category reduction**

In `src/lib/messageRenderingConfig.ts`:

Replace the `CATEGORIES` constant:

```ts
export const CATEGORIES = ["user", "agent", "system"] as const;
export type Category = (typeof CATEGORIES)[number];
```

Add the `KindDef` type and registry below the `KindStyle`/`CategoryStyle` definitions (keep `KindStyle` and `CategoryStyle` exactly as they are):

```ts
export interface KindDef {
  id: string;
  category: Category;
  label: string;
  description: string;
  /** Built-in chrome for this kind, layered over the category base. */
  default: Partial<KindStyle>;
}

/**
 * Source of truth for every kind the classifier / renderer actually emits.
 * `resolveKind` merges: category base → this `default` → user patch.
 * Adding a CLI kind = add an entry here; nothing else needs a flat list.
 */
export const KIND_REGISTRY: Record<string, KindDef> = {
  // ── agent ──
  "assistant.text": {
    id: "assistant.text", category: "agent",
    label: "Assistant text", description: "Claude's reply text.",
    default: {},
  },
  "assistant.text.endTurn": {
    id: "assistant.text.endTurn", category: "agent",
    label: "Execution complete", description: "Final assistant text that ended the turn.",
    default: { accentColor: "green", icon: "CheckCircle2", compactBoundaryLocked: true },
  },
  "assistant.thinking": {
    id: "assistant.thinking", category: "agent",
    label: "Thinking", description: "Extended-thinking blocks.",
    default: { presentation: "collapsible", headerLabel: "Thinking", icon: "Brain", widget: "ThinkingWidget", hiddenInCompact: true },
  },
  "assistant.tool-use": {
    id: "assistant.tool-use", category: "agent",
    label: "Tool call", description: "Claude invoking a tool.",
    default: { accentColor: "info", icon: "Terminal", headerLabel: null, hiddenInCompact: true },
  },
  "assistant.askUserQuestion": {
    id: "assistant.askUserQuestion", category: "agent",
    label: "Question (answered)", description: "An answered AskUserQuestion card.",
    default: { presentation: "card", icon: "MessageCircleQuestion", accentColor: "indigo", hiddenInCompact: false },
  },
  // ── user ──
  "user.prompt": {
    id: "user.prompt", category: "user",
    label: "User prompt", description: "What you typed.",
    default: { compactBoundaryLocked: true },
  },
  "user.command": {
    id: "user.command", category: "user",
    label: "Slash command", description: "A `/command` you ran.",
    default: { presentation: "side-line", icon: "ChevronRight", alignment: "left" },
  },
  "user.commandOutput": {
    id: "user.commandOutput", category: "user",
    label: "Command output", description: "Local stdout from a slash command.",
    default: { presentation: "side-line", alignment: "left", hiddenInCompact: true },
  },
  "user.subagentPrompt": {
    id: "user.subagentPrompt", category: "user",
    label: "Subagent prompt", description: "A prompt generated for a subagent.",
    default: { icon: "Bot", accentColor: "amber", alignment: "left" },
  },
  "user.skillInjection": {
    id: "user.skillInjection", category: "user",
    label: "Skill injection", description: "Skill body injected into the conversation.",
    default: { presentation: "collapsible", icon: "Sparkles", accentColor: "purple", alignment: "left" },
  },
  "user.systemContext": {
    id: "user.systemContext", category: "user",
    label: "System context", description: "Hook feedback, system-reminders, skill preambles.",
    default: { presentation: "collapsible", icon: "Sparkles", accentColor: "purple", showRawPayload: true, alignment: "left", hiddenInCompact: false },
  },
  "user.sdkSystemBracket": {
    id: "user.sdkSystemBracket", category: "user",
    label: "System notice", description: "CLI bracket notices like [Request interrupted].",
    default: { presentation: "side-line", icon: "Info", alignment: "left" },
  },
  "user.tool-result": {
    id: "user.tool-result", category: "user",
    label: "Tool result", description: "Output returned from a tool call.",
    default: { presentation: "side-line", headerLabel: null, alignment: "left", hiddenInCompact: true },
  },
  "user.image": {
    id: "user.image", category: "user",
    label: "Image", description: "A pasted or attached image.",
    default: { icon: "Image", alignment: "left" },
  },
  // ── system ──
  "system.notification.info": {
    id: "system.notification.info", category: "system",
    label: "Notification (info)", description: "Informational CLI notification.",
    default: { icon: "Bell", presentation: "card", hiddenInCompact: false },
  },
  "system.notification.warn": {
    id: "system.notification.warn", category: "system",
    label: "Notification (warn)", description: "Warning CLI notification.",
    default: { accentColor: "amber", icon: "Bell", presentation: "card", hiddenInCompact: false },
  },
  "system.notification.error": {
    id: "system.notification.error", category: "system",
    label: "Notification (error)", description: "Error CLI notification.",
    default: { accentColor: "red", icon: "Bell", presentation: "card", hiddenInCompact: false },
  },
  "system.notification.stop": {
    id: "system.notification.stop", category: "system",
    label: "Notification (stop)", description: "Stop CLI notification.",
    default: { accentColor: "red", icon: "Bell", presentation: "card", hiddenInCompact: false },
  },
  "system.hook_started": {
    id: "system.hook_started", category: "system",
    label: "Hook started", description: "A hook began running.",
    default: { icon: "Hook" },
  },
  "system.hook_response": {
    id: "system.hook_response", category: "system",
    label: "Hook response", description: "A hook returned.",
    default: { icon: "Hook" },
  },
  "system.permission_denied": {
    id: "system.permission_denied", category: "system",
    label: "Permission denied", description: "A tool permission was denied.",
    default: { accentColor: "red", icon: "ShieldX", presentation: "card", hiddenInCompact: false },
  },
  "system.userPromptSubmit": {
    id: "system.userPromptSubmit", category: "system",
    label: "Prompt submitted", description: "UserPromptSubmit lifecycle envelope.",
    default: { icon: "Send" },
  },
  "system.api_error": {
    id: "system.api_error", category: "system",
    label: "API error", description: "An API or tool error.",
    default: { accentColor: "red", icon: "AlertTriangle", presentation: "card", hiddenInCompact: false },
  },
  "system.unknown": {
    id: "system.unknown", category: "system",
    label: "System (other)", description: "Any unrecognized system subtype.",
    default: { icon: "Info" },
  },
  "permission.request": {
    id: "permission.request", category: "system",
    label: "Permission request", description: "Live tool-permission prompt.",
    default: { presentation: "card", icon: "ShieldQuestion", accentColor: "amber", hiddenInCompact: false },
  },
  "permission.askUserQuestion": {
    id: "permission.askUserQuestion", category: "system",
    label: "Question (live)", description: "Live AskUserQuestion prompt.",
    default: { presentation: "card", icon: "MessageCircleQuestion", accentColor: "indigo", hiddenInCompact: false },
  },
  // ── summary / fallback (resolve to system category) ──
  "summary.compaction": {
    id: "summary.compaction", category: "system",
    label: "Conversation summary", description: "Compaction summary card.",
    default: { icon: "FileText", presentation: "card", widget: "SummaryWidget", hiddenInCompact: false, compactBoundaryLocked: true },
  },
  "unknown": {
    id: "unknown", category: "system",
    label: "Unknown", description: "Unclassifiable message — shows raw payload.",
    default: { presentation: "side-line", icon: "HelpCircle", accentColor: "orange", borderStyle: "dashed", headerLabel: "Unknown", hiddenInCompact: false, compactBoundaryLocked: true, showRawPayload: true },
  },
};

export function categoryOf(id: string): Category {
  return KIND_REGISTRY[id]?.category ?? "system";
}
```

Reduce `DEFAULT_CATEGORIES` to the three real categories (delete the `attachment` and `bookkeeping` entries):

```ts
export const DEFAULT_CATEGORIES: Record<Category, CategoryStyle> = {
  user:   { label: "User",   description: "Your prompts, commands, tool results, injected context.", presentation: "card", accentColor: "blue",    icon: "User", headerLabel: "You",    borderStyle: "solid", alignment: "right", hiddenInCompact: false },
  agent:  { label: "Agent",  description: "Claude's text, thinking, tool calls, completions.",        presentation: "card", accentColor: "primary", icon: "Bot",  headerLabel: "Claude", borderStyle: "solid", alignment: "left",  hiddenInCompact: false },
  system: { label: "System", description: "Notifications, hooks, errors, lifecycle, prompts.",         presentation: "card", accentColor: "muted",   icon: "Info", headerLabel: null,     borderStyle: "solid", alignment: "left",  hiddenInCompact: true  },
};
```

Delete `BOOKKEEPING_IDS`, `originOf`, `kindOverride`, `DEFAULT_OVERRIDES`, and `KNOWN_KIND_IDS` (later tasks remove their remaining references; the build will stay red until Task A2/A3 — that's expected within this phase).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/messageRenderingConfig.test.ts -t "kind registry"`
Expected: the three "kind registry" tests PASS. (Other tests in the file may still fail until A2/A3 — acceptable.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/messageRenderingConfig.ts src/lib/__tests__/messageRenderingConfig.test.ts
git commit -m "feat(rendering): add KIND_REGISTRY + categoryOf, reduce categories to 3"
```

---

### Task A2: Rewrite `resolveKind` as the single three-layer resolver

**Files:**
- Modify: `src/lib/messageRenderingConfig.ts`
- Test: `src/lib/__tests__/messageRenderingConfig.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { resolveKind, createDefaultConfig } from "@/lib/messageRenderingConfig";

describe("resolveKind (three-layer merge)", () => {
  it("layers category → registry default → user patch", () => {
    const cfg = createDefaultConfig();
    // category base only (no registry default fields beyond category)
    expect(resolveKind(cfg, "assistant.text").icon).toBe("Bot"); // agent category icon

    // registry default wins over category
    expect(resolveKind(cfg, "permission.request").accentColor).toBe("amber");
    expect(resolveKind(cfg, "permission.request").icon).toBe("ShieldQuestion");

    // user patch wins over registry default
    cfg.kinds["permission.request"] = { accentColor: "teal" };
    expect(resolveKind(cfg, "permission.request").accentColor).toBe("teal");
    expect(resolveKind(cfg, "permission.request").icon).toBe("ShieldQuestion"); // unpatched field falls through
  });

  it("an unregistered id resolves to the system category base", () => {
    const cfg = createDefaultConfig();
    expect(resolveKind(cfg, "future.kind").accentColor).toBe("muted");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/messageRenderingConfig.test.ts -t "three-layer"`
Expected: FAIL — `resolveKind` still returns category base only / `config.kinds` undefined.

- [ ] **Step 3: Implement**

Replace the existing `resolveKind` body and delete `resolveMessageStyle`, `withResolvedKindStyle`, `conditionsMatch`, `getByPath`, `valuesForPath`, `valueSatisfies`, and the `MatchCondition`/`MatchOp`/`Override`/`JsonlNodeLike` types:

```ts
export function resolveKind(config: MessageRenderingConfig, kindId: string): KindStyle {
  return {
    ...config.categories[categoryOf(kindId)],
    ...KIND_REGISTRY[kindId]?.default,
    ...config.kinds[kindId],
  };
}
```

Remove the now-unused `import type { JsonlNode }` if nothing else in the file uses it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/messageRenderingConfig.test.ts -t "three-layer"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/messageRenderingConfig.ts src/lib/__tests__/messageRenderingConfig.test.ts
git commit -m "feat(rendering): collapse resolution to single resolveKind, delete match engine"
```

---

### Task A3: v5 config shape + merge (full reset on any other version)

**Files:**
- Modify: `src/lib/messageRenderingConfig.ts`
- Test: `src/lib/__tests__/messageRenderingConfig.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { createDefaultConfig, mergeConfig, parseConfig, serializeConfig } from "@/lib/messageRenderingConfig";

describe("config v5", () => {
  it("default config is version 5 with an empty kinds map", () => {
    const cfg = createDefaultConfig();
    expect(cfg.version).toBe(5);
    expect(cfg.kinds).toEqual({});
  });

  it("round-trips a v5 config with user kind patches", () => {
    const cfg = createDefaultConfig();
    cfg.kinds["user.prompt"] = { accentColor: "teal" };
    const back = parseConfig(serializeConfig(cfg));
    expect(back.kinds["user.prompt"]).toEqual({ accentColor: "teal" });
  });

  it("resets to defaults when the saved version is not 5", () => {
    const merged = mergeConfig({ version: 4, overrides: [{ id: "x", category: "system", match: [], style: {} }] });
    expect(merged.version).toBe(5);
    expect(merged.kinds).toEqual({});
  });

  it("drops junk fields in a saved kinds patch", () => {
    const merged = mergeConfig({
      version: 5,
      kinds: { "user.prompt": { accentColor: "teal", icon: "NotARealIcon", bogus: 1 } },
    });
    expect(merged.kinds["user.prompt"]).toEqual({ accentColor: "teal" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/messageRenderingConfig.test.ts -t "config v5"`
Expected: FAIL — config is still version 4 with `overrides`.

- [ ] **Step 3: Implement**

Update the `MessageRenderingConfig` interface — replace `version: 4` with `version: 5` and replace the `overrides: Override[]` field with `kinds: Record<string, Partial<KindStyle>>`:

```ts
export interface MessageRenderingConfig {
  version: 5;
  defaultViewMode: "compact" | "verbose";
  categories: Record<Category, CategoryStyle>;
  kinds: Record<string, Partial<KindStyle>>;
  palette: Palette;
  hardFilters: HardFilters;
  typography: Typography;
  terminal: Terminal;
  debug: DebugOptions;
}
```

Update `createDefaultConfig`:

```ts
export function createDefaultConfig(): MessageRenderingConfig {
  return {
    version: 5,
    defaultViewMode: "verbose",
    categories: structuredClone(DEFAULT_CATEGORIES),
    kinds: {},
    palette: structuredClone(DEFAULT_PALETTE),
    hardFilters: { ...DEFAULT_HARD_FILTERS },
    typography: structuredClone(DEFAULT_TYPOGRAPHY),
    terminal: { ...DEFAULT_TERMINAL },
    debug: { ...DEFAULT_DEBUG },
  };
}
```

Add a `validateKindsMap` helper (reuses the existing `validateStyleField` + `STYLE_FIELDS`, which stay):

```ts
function validateKindsMap(raw: unknown, palette: Palette): Record<string, Partial<KindStyle>> {
  const out: Record<string, Partial<KindStyle>> = {};
  if (!isRecord(raw)) return out;
  for (const [id, patch] of Object.entries(raw)) {
    if (!isRecord(patch)) continue;
    const clean: Record<string, unknown> = {};
    for (const f of STYLE_FIELDS) {
      const v = validateStyleField(f, patch, palette);
      if (v !== undefined) clean[f] = v;
    }
    if (Object.keys(clean).length > 0) out[id] = clean as Partial<KindStyle>;
  }
  return out;
}
```

Replace the whole body of `mergeConfig` (delete the v2/v3/v4 branches, keep `mergeCategories`, `mergeShared`, `mergeTypographyStyle`, `mergeIconStyle`):

```ts
export function mergeConfig(saved: unknown): MessageRenderingConfig {
  const base = createDefaultConfig();
  if (!isRecord(saved) || saved.version !== 5) return base; // full reset
  mergeCategories(base, saved);
  base.kinds = validateKindsMap(saved.kinds, base.palette);
  return mergeShared(base, saved);
}
```

In `mergeCategories`, the `for (const c of CATEGORIES)` loop now iterates only the three real categories — no change needed beyond the `CATEGORIES` reduction from A1.

Delete `pruneRedundantOverrides`, `upsertKindOverride`, `validateMatch`, `validateOverride`, `isCategory` (if only used by override validation), and the `MATCH_OPS` constant.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/messageRenderingConfig.test.ts`
Expected: the "config v5" tests PASS. Update or delete any stale assertions in this file that referenced `overrides`, `KNOWN_KIND_IDS`, or `DEFAULT_OVERRIDES` (replace with registry/`kinds` equivalents).

- [ ] **Step 5: Commit**

```bash
git add src/lib/messageRenderingConfig.ts src/lib/__tests__/messageRenderingConfig.test.ts
git commit -m "feat(rendering): config v5 (id-keyed kinds map), reset on older versions"
```

---

## Phase B — Accent helpers collapse

### Task B1: Make accent helpers cascade-aware and delete the `resolved*` trio

**Files:**
- Modify: `src/lib/accentStyle.ts`
- Test: `src/lib/__tests__/accentStyle.test.ts`

- [ ] **Step 1: Write the failing test**

Replace the body of `src/lib/__tests__/accentStyle.test.ts` assertions that reference `resolvedAccentStyleFor`/`resolvedSwatchFor` with:

```ts
import { accentStyleFor, swatchFor } from "@/lib/accentStyle";
import { createDefaultConfig } from "@/lib/messageRenderingConfig";

describe("accentStyleFor (cascade-aware via resolveKind)", () => {
  it("applies the registry default accent for a live card kind", () => {
    const cfg = createDefaultConfig();
    // permission.request default accent is amber (#f59e0b) → border uses that hex
    expect(swatchFor(cfg, "permission.request")).toBe("#f59e0b");
    expect(accentStyleFor(cfg, "permission.request")?.borderColor).toBe("#f59e0b55");
  });

  it("honors a user kind patch over the registry default", () => {
    const cfg = createDefaultConfig();
    cfg.kinds["permission.request"] = { accentColor: "#123456" };
    expect(swatchFor(cfg, "permission.request")).toBe("#123456");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/accentStyle.test.ts`
Expected: FAIL — old tests import deleted symbols / `swatchFor` returns category gray.

- [ ] **Step 3: Implement**

In `src/lib/accentStyle.ts`, delete `resolvedAccentFor`, `resolvedAccentStyleFor`, `resolvedSwatchFor`, and the `resolveMessageStyle` import. `accentFor` already calls `resolveKind`, which is now cascade-aware — no change to `accentFor`/`accentStyleFor`/`swatchFor` bodies beyond removing the unused import:

```ts
import {
  isHexColor,
  resolveKind,
  type MessageRenderingConfig,
  type PaletteEntry,
} from "./messageRenderingConfig";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/accentStyle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/accentStyle.ts src/lib/__tests__/accentStyle.test.ts
git commit -m "refactor(rendering): collapse accent helpers to one cascade-aware set"
```

---

### Task B2: Point the live cards at the unified helper

**Files:**
- Modify: `src/components/PermissionCard.tsx:103,104,282,283`
- Modify: `src/components/AskUserQuestionCard.tsx:5,80,81`
- Test: `src/components/__tests__/MessageCard.test.tsx` (add a focused live-card color test) — or create `src/components/__tests__/liveCardAccent.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/liveCardAccent.test.tsx`:

```tsx
import { render } from "@testing-library/react";
import { MessageRenderingPreviewProvider } from "@/contexts/MessageRenderingContext";
import { createDefaultConfig } from "@/lib/messageRenderingConfig";
import { PermissionCard } from "@/components/PermissionCard";

function renderCard() {
  const cfg = createDefaultConfig();
  const request = {
    kind: "tool",
    toolName: "Bash",
    toolInput: { command: "ls" },
    title: "",
    displayName: "Bash",
    description: "",
    suggestions: [{}],
  } as never;
  return render(
    <MessageRenderingPreviewProvider config={cfg}>
      <PermissionCard request={request} onAllow={() => {}} onDeny={() => {}} />
    </MessageRenderingPreviewProvider>,
  );
}

it("permission card paints its amber accent, not category gray", () => {
  const { container } = renderCard();
  const card = container.querySelector("div[style]") as HTMLElement;
  expect(card.style.borderColor).toBe("#f59e0b55"); // amber, not #4b556355 (muted)
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/__tests__/liveCardAccent.test.tsx`
Expected: FAIL — `PermissionCard` still calls `accentStyleFor` which (before B1) returned category gray; after B1 it passes, but confirm the import path. If `PermissionCard` still imports a deleted symbol the file won't compile — fix in Step 3.

- [ ] **Step 3: Implement**

`PermissionCard.tsx` already imports `accentStyleFor, swatchFor` from `@/lib/accentStyle` and calls `accentStyleFor(config, "permission.request")` — these are now correct (cascade-aware). No change needed there; the bug is fixed by B1. Verify both `PermissionCard` and the inner `CodexPermissionCard` use `accentStyleFor`/`swatchFor` (they do, at lines 103-104 and 282-283).

In `AskUserQuestionCard.tsx`, change the import and calls from the `resolved*` helpers to the unified ones:

```tsx
// line 5
import { accentStyleFor, swatchFor } from "@/lib/accentStyle";
// lines 80-81
const accentStyle = accentStyleFor(config, 'permission.askUserQuestion');
const accentSwatch = swatchFor(config, 'permission.askUserQuestion');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/__tests__/liveCardAccent.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/PermissionCard.tsx src/components/AskUserQuestionCard.tsx src/components/__tests__/liveCardAccent.test.tsx
git commit -m "fix(rendering): live cards use unified accent helper (fixes gray permission card)"
```

---

## Phase C — Renderer call-site migration

### Task C1: Simplify `MessageFrame` (drop cascade + effConfig)

**Files:**
- Modify: `src/components/StreamMessage/MessageFrame.tsx`
- Test: `src/components/StreamMessage/__tests__/MessageFrame.test.tsx` (create if absent)

- [ ] **Step 1: Write the failing test**

Create `src/components/StreamMessage/__tests__/MessageFrame.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { MessageRenderingProvider } from "@/contexts/MessageRenderingContext";
import { MessageFrame } from "@/components/StreamMessage/MessageFrame";

it("renders children inside the resolved presentation variant", () => {
  render(
    <MessageRenderingProvider>
      <MessageFrame streamKind="assistant.text">
        <span>hello body</span>
      </MessageFrame>
    </MessageRenderingProvider>,
  );
  expect(screen.getByText("hello body")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/StreamMessage/__tests__/MessageFrame.test.tsx`
Expected: FAIL to compile — `MessageFrame` still imports deleted `resolveMessageStyle`/`withResolvedKindStyle`.

- [ ] **Step 3: Implement**

In `src/components/StreamMessage/MessageFrame.tsx`:

Change the imports (line 3) to:

```tsx
import { resolveKind } from '@/lib/messageRenderingConfig';
```

Replace the `useMemo` block (lines 45-51) with a direct resolve and drop `effConfig`:

```tsx
const kind = React.useMemo(() => resolveKind(config, streamKind), [config, streamKind]);
```

The `rawPayload`, presentation branches, and side-line icon-chrome code stay as-is (they read `kind.*` and `config.typography.icon`). Replace the final return (lines 116-120) — no more `effConfig`; descendants read the live `config` and `resolveKind` gives them the per-kind style directly:

```tsx
return inner;
```

Remove the now-unused `MessageRenderingPreviewProvider` import from this file (it stays exported from the context for the settings preview).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/StreamMessage/__tests__/MessageFrame.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/StreamMessage/MessageFrame.tsx src/components/StreamMessage/__tests__/MessageFrame.test.tsx
git commit -m "refactor(rendering): MessageFrame resolves kind directly, no per-message cascade"
```

---

### Task C2: Swap `resolveMessageStyle` call sites to `resolveKind`

**Files:**
- Modify: `src/lib/compactGrouping.ts:2,28`
- Modify: `src/components/StreamMessage.tsx:12,714` (the `resolveMessageStyle(renderConfig, message, blockKind)` call)
- Test: `src/lib/__tests__/compactGrouping.test.ts`

- [ ] **Step 1: Write the failing test**

Confirm/replace in `src/lib/__tests__/compactGrouping.test.ts` an assertion that a hidden kind groups. Add if missing:

```ts
import { groupCompact } from "@/lib/compactGrouping";
import { createDefaultConfig } from "@/lib/messageRenderingConfig";

it("groups a fully-hidden tool-use message into a hidden run", () => {
  const cfg = createDefaultConfig();
  const toolUse = {
    kind: "assistant", sessionId: "", receivedAt: "",
    raw: { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", id: "t1", input: {} }] } },
  } as never;
  // assistant.tool-use default is hiddenInCompact:true and not boundary-locked
  const entries = groupCompact([toolUse], [toolUse], cfg);
  expect(entries[0].kind).toBe("hidden-run");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/compactGrouping.test.ts`
Expected: FAIL to compile — `compactGrouping.ts` imports deleted `resolveMessageStyle`.

- [ ] **Step 3: Implement**

`src/lib/compactGrouping.ts` line 2 → `import { resolveKind, type MessageRenderingConfig } from './messageRenderingConfig';`
Line 28 → `const style = resolveKind(config, wholeKind);`

`src/components/StreamMessage.tsx` line 12 → `import { resolveKind } from "@/lib/messageRenderingConfig";`
Line ~714 → replace `resolveMessageStyle(renderConfig, message, blockKind)` with `resolveKind(renderConfig, blockKind)`.

`src/lib/blockKind.ts` line 4 + line 163: change `import { resolveMessageStyle, ... }` to `import { resolveKind, ... }` and `resolveMessageStyle(config, parent, id)` → `resolveKind(config, id)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/compactGrouping.test.ts src/lib/__tests__/blockKind.test.ts`
Expected: PASS (create the blockKind test target only if it exists; otherwise skip that path).

- [ ] **Step 5: Commit**

```bash
git add src/lib/compactGrouping.ts src/components/StreamMessage.tsx src/lib/blockKind.ts src/lib/__tests__/compactGrouping.test.ts
git commit -m "refactor(rendering): swap remaining resolveMessageStyle callers to resolveKind"
```

---

### Task C3: Unify the tool-result kind id

**Files:**
- Modify: `src/components/StreamMessage.tsx` (every `kindId="tool.result.generic"` and `userKindId = ... "tool.result.generic"`)
- Test: covered by `npm run check` + existing `MessageCard.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `src/lib/__tests__/messageRenderingConfig.test.ts`:

```ts
it("does not register the old duplicate tool-result id", () => {
  expect(KIND_REGISTRY["tool.result.generic"]).toBeUndefined();
  expect(KIND_REGISTRY["user.tool-result"]).toBeDefined();
});
```

- [ ] **Step 2: Run test to verify it fails (or passes trivially)**

Run: `npx vitest run src/lib/__tests__/messageRenderingConfig.test.ts -t "duplicate tool-result"`
Expected: PASS already (registry has only `user.tool-result`). This guards the rename below.

- [ ] **Step 3: Implement**

In `src/components/StreamMessage.tsx`, replace all string literals `"tool.result.generic"` with `"user.tool-result"` (the `userKindId` ternary at ~line 956, and every `KindHeader kindId="tool.result.generic"`). `categoryOf("user.tool-result")` is `user`, so tool-result headers now theme under the user category — confirm visually this reads acceptably; if a neutral look is preferred, adjust the `user.tool-result` registry `default` (it already sets `presentation: "side-line"`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run check`
Expected: no references to `tool.result.generic` remain; typecheck passes for these files.

- [ ] **Step 5: Commit**

```bash
git add src/components/StreamMessage.tsx src/lib/__tests__/messageRenderingConfig.test.ts
git commit -m "refactor(rendering): unify tool-result kind id to user.tool-result"
```

---

### Task C4: Simplify the context's version-reset load path

**Files:**
- Modify: `src/contexts/MessageRenderingContext.tsx:25-65`
- Test: covered by `npm run check` + an added assertion in `src/lib/__tests__/messageRenderingConfig.test.ts` (already added in A3: "resets to defaults when the saved version is not 5").

`MessageRenderingContext` has its OWN load-time version guard (resets `version < 2`, otherwise `parseConfig(raw)`). With v5's `mergeConfig` resetting any non-v5 config, that branch is redundant but its log message still says "v4". Simplify it.

- [ ] **Step 1: Implement**

Replace the `useEffect` body (lines 25-65) load logic with a single path that trusts `parseConfig` (which now resets non-v5 internally), logging only when a reset actually happened:

```tsx
useEffect(() => {
  let cancelled = false;
  logAndForget('message-rendering-context:iife', (async () => {
    try {
      const raw = await api.getSetting(MESSAGE_RENDERING_CONFIG_KEY);
      const parsed = parseConfig(raw);            // resets non-v5 to defaults
      let wasReset = !raw;
      try { wasReset = wasReset || (JSON.parse(raw ?? 'null') as { version?: unknown } | null)?.version !== 5; }
      catch { wasReset = true; }
      if (wasReset && !cancelled) {
        await api.saveSetting(MESSAGE_RENDERING_CONFIG_KEY, serializeConfig(parsed));
        await api.logWriteBatch([{
          timestamp: new Date().toISOString(),
          level: 'info', source: 'frontend',
          category: 'settings:message-rendering',
          message: 'reset message rendering config to v5 defaults',
        }]);
      }
      if (!cancelled) setConfigState(parsed);
    } catch {
      /* keep defaults */
    } finally {
      if (!cancelled) setLoaded(true);
    }
  })());
  return () => { cancelled = true; };
}, []);
```

- [ ] **Step 2: Verify**

Run: `npm run check`
Expected: clean. The `MessageRenderingPreviewProvider` and `useMessageRenderingConfig` below stay unchanged.

- [ ] **Step 3: Commit**

```bash
git add src/contexts/MessageRenderingContext.tsx
git commit -m "refactor(rendering): context load resets any non-v5 config to defaults"
```

---

## Phase D — Settings UI (registry-driven, override editor removed)

### Task D1: Delete the match-rule UI and its wiring

**Files:**
- Delete: `src/components/settings-panels/appearance/OverrideMatchDialog.tsx`
- Delete: `src/components/settings-panels/appearance/MatchingRules.tsx`
- Delete: `src/components/settings-panels/appearance/__tests__/OverrideMatchDialog.test.tsx`
- Delete: `src/lib/__tests__/messageMatch.test.ts`
- Modify: `src/components/settings-panels/AppearanceSettings.tsx`

- [ ] **Step 1: Delete the files**

```bash
git rm src/components/settings-panels/appearance/OverrideMatchDialog.tsx \
       src/components/settings-panels/appearance/MatchingRules.tsx \
       src/components/settings-panels/appearance/__tests__/OverrideMatchDialog.test.tsx \
       src/lib/__tests__/messageMatch.test.ts
```

- [ ] **Step 2: Rewire `AppearanceSettings.tsx`**

Concretely, in `AppearanceSettings.tsx`:

- **Imports (lines 9-33):** drop `pruneRedundantOverrides`, `originOf`, `type MatchCondition`, `MatchingRules`, `OverrideMatchDialog`, `previewTextForOverride`, `exampleRawForCategory`. Keep `previewTextForCategory`; add `previewTextForKindId` from `./appearance/fixtures` (see D3). `TreeSelection` is imported from `MessageKindTree` (D2) and becomes `{ type: "category"; id: Category } | { type: "kind"; id: string }`.
- **Delete** the `dialog` state (lines 75-79), `openAddDialog`/`openEditDialog`/`closeDialog`/`saveDialog` (lines 289-308), `createOverride`/`updateOverrideMatch`/`removeOverride`/`patchOverrideStyle`/`setOverrideField`/`clearOverrideField` (lines 214-287), and the entire `{dialog && …}` render block (lines 729-746).
- **`mutate` (lines 133-140):** drop the `pruneRedundantOverrides` wrapper and the `exempt` set — commit the produced config directly:

```tsx
const mutate = useCallback(
  (producer: (prev: MessageRenderingConfig) => MessageRenderingConfig) => {
    commitConfig(producer(config));
    scheduleSavedToast();
  },
  [config, commitConfig, scheduleSavedToast],
);
```

- **Add kind editing** (replaces the override editing block):

```tsx
const updateKind = useCallback(
  (id: string, patch: Partial<KindStyle>) => {
    mutate((prev) => ({ ...prev, kinds: { ...prev.kinds, [id]: { ...(prev.kinds[id] ?? {}), ...patch } } }));
  },
  [mutate],
);

const clearKindField = useCallback(
  (id: string, field: keyof KindStyle) => {
    mutate((prev) => {
      const next = { ...(prev.kinds[id] ?? {}) };
      delete next[field];
      const kinds = { ...prev.kinds };
      if (Object.keys(next).length === 0) delete kinds[id]; else kinds[id] = next;
      return { ...prev, kinds };
    });
  },
  [mutate],
);

const resetKind = useCallback(
  (id: string) => {
    mutate((prev) => {
      const kinds = { ...prev.kinds };
      delete kinds[id];
      return { ...prev, kinds };
    });
    setToast({ message: `Reset "${KIND_REGISTRY[id]?.label ?? id}" to default`, type: "success" });
  },
  [mutate, setToast],
);
```

- **`editor` memo (lines 394-441):** the category branch stays. Replace the override branch with a kind branch — resolve the kind's effective style via `resolveKind(config, id)`, the raw patch via `config.kinds[id]`, and the inherited label via the kind's category:

```tsx
if (selected.type === "kind") {
  const def = KIND_REGISTRY[selected.id];
  const cat = categoryOf(selected.id);
  return {
    mode: "kind" as const,
    kindId: selected.id,
    label: def?.label ?? selected.id,
    description: def?.description ?? `Inherits the ${config.categories[cat].label} category.`,
    style: resolveKind(config, selected.id),
    previewText: previewTextForKindId(selected.id),
    onChange: (patch: Partial<KindStyle>) => { updateKind(selected.id, patch); },
    onClearField: (field: keyof KindStyle) => { clearKindField(selected.id, field); },
    onReset: () => { resetKind(selected.id); },
    inheritedCategoryLabel: config.categories[cat].label,
    override: config.kinds[selected.id],
  };
}
```

Import `resolveKind`, `categoryOf`, `KIND_REGISTRY` from `@/lib/messageRenderingConfig`. Remove the `MatchingRules` JSX (lines 497-512) and the `rules` field from the editor object. Update the `<MessageKindTree>` props (lines 470-477) to just `{ config, selected, onSelect: setSelected }`, and the `<KindEditor>` `mode` prop now receives `editor.mode` which is `"category" | "kind"` (see D3 for the editor's mode rename). Update the heading copy (lines 459-465) to describe editing a category or a specific kind (drop the "override" language).

- [ ] **Step 3: Run typecheck**

Run: `npm run check`
Expected: `AppearanceSettings.tsx` compiles; no dangling imports.

- [ ] **Step 4: Commit**

```bash
git add -A src/components/settings-panels/
git commit -m "feat(settings): remove override/match editor, switch to category+kind selection"
```

---

### Task D2: Registry-driven kind tree

**Files:**
- Modify: `src/components/settings-panels/appearance/MessageKindTree.tsx`
- Test: `src/components/settings-panels/__tests__/AppearanceSettings.presentation.test.tsx`

- [ ] **Step 1: Write the failing test**

Add a test asserting the tree lists registry kinds grouped by category:

```tsx
import { render, screen } from "@testing-library/react";
import { MessageKindTree } from "@/components/settings-panels/appearance/MessageKindTree";
import { createDefaultConfig } from "@/lib/messageRenderingConfig";

it("lists registry kinds under their category", () => {
  render(
    <MessageKindTree
      config={createDefaultConfig()}
      selected={{ type: "category", id: "system" }}
      onSelect={() => {}}
    />,
  );
  expect(screen.getByText("Permission request")).toBeInTheDocument();   // system kind label
  expect(screen.getByText("Execution complete")).toBeInTheDocument();   // agent kind label
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/settings-panels/__tests__/AppearanceSettings.presentation.test.tsx`
Expected: FAIL — tree still iterates `config.overrides`.

- [ ] **Step 3: Implement**

Rewrite `MessageKindTree.tsx` to iterate `KIND_REGISTRY` grouped by `category`, instead of `config.overrides`. Each category node expands to its registry kinds (filter `Object.values(KIND_REGISTRY)` by `def.category === c`, sort by `label`). Each kind row shows the resolved icon/accent (`resolveKind(config, def.id)`), the `def.label`, and the eye-off/lock indicators from the resolved style. Drop `onAddOverride`/`onEditOverride`/`onRemoveOverride` props and the `Plus`/`Pencil`/`Trash2` affordances. The new props are `{ config, selected, onSelect }` with `onSelect({ type: "kind", id })`.

Representative row source:

```tsx
import { CATEGORIES, KIND_REGISTRY, resolveKind } from "@/lib/messageRenderingConfig";
// ...
{CATEGORIES.map((c) => {
  const kinds = Object.values(KIND_REGISTRY)
    .filter((d) => d.category === c)
    .sort((a, b) => a.label.localeCompare(b.label));
  // render category node + kind rows; each row:
  //   const style = resolveKind(config, def.id);
  //   icon = style.icon, swatch = swatchHex(style.accentColor, config.palette)
})}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/settings-panels/__tests__/AppearanceSettings.presentation.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings-panels/appearance/MessageKindTree.tsx src/components/settings-panels/__tests__/AppearanceSettings.presentation.test.tsx
git commit -m "feat(settings): registry-driven kind tree"
```

---

### Task D3: rename `KindEditor` mode; fix fixtures + TurnPreview to real ids

**Files:**
- Modify: `src/components/settings-panels/appearance/KindEditor.tsx`
- Modify: `src/components/settings-panels/appearance/fixtures.ts`
- Modify: `src/components/settings-panels/appearance/TurnPreview.tsx`
- (`SamplePreview.tsx` only needs a check — it receives `style`/`kindId`/`text` as props from `AppearanceSettings` and renders through `MessageFrame`; no registry coupling. Read it and confirm; only change if it imports a deleted symbol.)

- [ ] **Step 1: KindEditor — rename the `"override"` mode to `"kind"`**

`KindEditor`'s field plumbing already works for "a sparse patch over an inherited base" — that is exactly the new kind model (`config.kinds[id]` over registry default ⊕ category). The only change is terminology so the component matches the new selection type.

In `KindEditor.tsx`:
- Line 38: `export type KindEditorMode = "category" | "kind";`
- The `isOverride` local (line 227) becomes `isKind`: `const isKind = mode === "kind";` and replace every `isOverride` usage with `isKind`. (Internal var rename only — behavior identical: `has()` checks `Object.prototype.hasOwnProperty.call(ov, field)` against the `override` prop, which AppearanceSettings now passes as `config.kinds[id]`.)
- Header text (lines 252, 256-258, 576-579): change "override" wording to "kind" — e.g. the id line shows `id: ${kindId}` for kind mode; the reset button label becomes `"Reset to default"` for kind mode and stays `"Reset category to default"` for category mode.
- The `InheritHint` "inherited from {categoryLabel}" copy is still accurate (an unset field inherits its value from the registry default / category). No logic change.

- [ ] **Step 2: fixtures.ts — prune to real registry ids**

Rewrite `KIND_FIXTURES` to cover only registry ids (drop `attachment.*`, `pr-link`, `queue-operation`, `permission-mode`, `last-prompt`, `ai-title`, `file-history-snapshot`, `system.compact_boundary`, `cli-stream-init`, `cli-stream-result`). Add fixtures for the now-real ids that lacked one (`user.commandOutput`, `user.subagentPrompt`, `user.skillInjection`, `user.sdkSystemBracket`, `user.image`, the four `system.notification.*`, `system.hook_started`, `system.hook_response`, `system.permission_denied`, `system.userPromptSubmit`, `system.unknown`, `permission.request`, `permission.askUserQuestion`, `assistant.askUserQuestion`). Keep `previewTextForKindId`. Delete `previewTextForOverride`, `CATEGORY_RAW_FIXTURES`, `exampleRawForCategory` (only the deleted match dialog used the raw fixtures). Reduce `CATEGORY_FIXTURES` to the three real categories. Rewrite `FAKE_TURN_KIND_IDS` to use only registry ids (replace `attachment.todo_reminder` → drop; `pr-link` → drop; `cli-stream-result` → `system.unknown` or drop; keep the user→assistant→system arc). Update the file's header comment (it references the "v3 category model" / `originOf`).

- [ ] **Step 3: TurnPreview.tsx — verify it resolves through `resolveKind`**

`TurnPreview` consumes `FAKE_TURN_KIND_IDS` + `config`. Confirm it renders each id through `MessageFrame`/`resolveKind` (not a deleted helper). Fix any deleted-symbol import. No structural change expected beyond the fixtures update in Step 2.

- [ ] **Step 4: Verify**

Run: `npm run check`
Then run: `npx vitest run src/components/settings-panels`
Expected: typecheck clean; settings tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings-panels/appearance/KindEditor.tsx src/components/settings-panels/appearance/fixtures.ts src/components/settings-panels/appearance/TurnPreview.tsx
git commit -m "feat(settings): KindEditor kind mode + real-id fixtures/turn preview"
```

---

## Phase E — Sweep, defaults, verification

### Task E1: Compile-clean sweep

**Files:** any remaining importers flagged by the compiler — `iconChrome.ts`, `kindPresentation.ts`, `MessageFrameCard.tsx`, `MessageFrameSideLine.tsx`, `MessageFrameCollapsible.tsx`, `KindHeader.tsx`, `messageFilters.ts`, and their tests.

- [ ] **Step 1: Typecheck and fix**

Run: `npm run check`
For each error: a deleted-symbol import (`resolveMessageStyle`, `Override`, `KNOWN_KIND_IDS`, `DEFAULT_OVERRIDES`, `originOf`, `resolved*`) → replace with `resolveKind` / `categoryOf` / `KIND_REGISTRY` as appropriate. These components already call `resolveKind(config, id)` for chrome, so most need only an import fix.

- [ ] **Step 2: Update/trim stale tests**

Run: `npm test`
Fix or delete tests asserting removed behavior (`messageRenderingConfig.test.ts` override cases, `kindPresentation.test.ts`, `messageFilters.test.ts` if they reference `overrides`). Keep coverage for the new resolver.

- [ ] **Step 3: Add the classifier↔registry coverage test**

Add to `src/lib/__tests__/messageKind.test.ts`:

```ts
import { KIND_REGISTRY } from "@/lib/messageRenderingConfig";

// Every id classifyStandaloneKind / classifyBlockKind / the live cards can emit
// must have a registry entry, so it gets real chrome instead of the fallback.
const EMITTABLE_IDS = [
  "assistant.text", "assistant.text.endTurn", "assistant.thinking", "assistant.tool-use",
  "assistant.askUserQuestion",
  "user.prompt", "user.command", "user.commandOutput", "user.subagentPrompt",
  "user.skillInjection", "user.systemContext", "user.sdkSystemBracket",
  "user.tool-result", "user.image",
  "system.notification.info", "system.notification.warn", "system.notification.error",
  "system.notification.stop", "system.hook_started", "system.hook_response",
  "system.permission_denied", "system.userPromptSubmit", "system.api_error", "system.unknown",
  "permission.request", "permission.askUserQuestion",
  "summary.compaction", "unknown",
];

it("every emittable kind id is registered", () => {
  for (const id of EMITTABLE_IDS) expect(KIND_REGISTRY[id], id).toBeDefined();
});

it("no registry id is dead weight (all are in the emittable set)", () => {
  for (const id of Object.keys(KIND_REGISTRY)) expect(EMITTABLE_IDS, id).toContain(id);
});
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(rendering): compile-clean sweep + classifier/registry coverage test"
```

---

### Task E2: Regenerate the config doc + final verification

**Files:**
- Modify: `docs/message-rendering-config.yaml`

- [ ] **Step 1: Update the doc**

Rewrite `docs/message-rendering-config.yaml` to describe the v5 shape: `categories` (3), `kinds` (sparse id-keyed patches), and the registry as the kind catalog. Remove the `overrides`/match-rule documentation.

- [ ] **Step 2: Full verification gate**

Run, in order:
- `npm run check` — Expected: clean.
- `npm run build` — Expected: succeeds.
- `npm test` — Expected: all pass.

- [ ] **Step 3: Rebuild Electron native module**

Run: `npm run rebuild:electron`
(Required after a vitest run so the app starts cleanly for Greg.)

- [ ] **Step 4: Commit**

```bash
git add docs/message-rendering-config.yaml
git commit -m "docs(rendering): document v5 id-keyed config; remove override model"
```

- [ ] **Step 5: Manual smoke (Greg, optional)**

Launch with throwaway state to confirm fresh-default colors:
`npm start -- --user-data-dir=/tmp/omnifex-firstrun`
Confirm: permission prompt is amber, AskUserQuestion question + answer cards are indigo (not gray), Settings → Chats shows ~28 kinds in three category groups, no "Add override" UI.

---

## Self-review (completed during planning)

- **Spec coverage:** §1 model → A1/A2; §2 resolver → A2, accent collapse → B1; §3 catalog → A1 registry + E1 coverage test; §4 special cases → unchanged (C2/C3 keep classifier ownership); §5 renderer/settings → C1/C4/D1/D2/D3; §6 colors → A1 registry defaults + E2 smoke; §7 migration → A3 reset + C4 context load; testing/verification → E2.
- **Placeholder scan:** no TBD/TODO; code shown for every code step. All touched files (`AppearanceSettings`, `KindEditor`, `fixtures`, `compactGrouping`, `MessageRenderingContext`) were read in full before finalizing, so D1/D3/C4 cite exact line ranges and concrete replacements rather than "read it first."
- **Type consistency:** `resolveKind(config, id)` (2 args, no message) used everywhere; `categoryOf` replaces `originOf`; `config.kinds` (not `overrides`); `KindStyle`/`CategoryStyle`/`KindDef` names consistent; `KindEditor` mode is `"category" | "kind"` across D1/D3; live-card helper is `accentStyleFor`/`swatchFor` throughout.
- **Known soft spots:** (1) Task C3's tool-result re-theming under the `user` category is a visual judgment to confirm in the E2 smoke. (2) `SamplePreview.tsx` was not captured in full; D3 Step 3 treats it as a check-and-fix-if-needed rather than a guaranteed edit. (3) The exact final `FAKE_TURN_KIND_IDS` ordering is left to the implementer's judgment within the stated constraint (registry ids only, user→assistant→system arc).
