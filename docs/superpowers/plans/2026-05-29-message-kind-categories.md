# Message-Kind Categories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat 64-entry message-rendering catalog with a two-tier model — 5 categories (default styling by origin) plus a small set of per-kind overrides (as-needed special handling) — so every kind resolves to a defined style, the settings list shrinks, and new CLI types stop falling to `unknown`.

**Architecture:** A new `resolveKind(config, kindId)` returns `categoryDefault(originOf(kindId)) ⊕ override[kindId]`. The classifier is unchanged (still emits dotted kind ids); every current `config.kinds[id]` read routes through `resolveKind`. Config schema bumps v2→v3 (`categories` + sparse `overrides`); a migration converts existing per-kind customizations into overrides. Phase A delivers the model + migration + rendering with the settings UI kept working via the resolver; Phase B replaces the settings UI with category editors + an override list.

**Tech Stack:** TypeScript, React 18, Vitest, Zustand, the existing `messageRenderingConfig` / `MessageRenderingContext` / `MessageFrame` stack.

**Spec:** `docs/superpowers/specs/2026-05-29-message-kind-categories-design.md`

---

## File Structure

- `src/lib/messageRenderingConfig.ts` — add `Category`, `KindStyle`, `CategoryStyle`, v3 config type, `DEFAULT_CATEGORIES`, `DEFAULT_OVERRIDES`, `originOf`, `resolveKind`; rework `createDefaultConfig` + `mergeConfig` for v3. (Largest change; the file already owns all of this.)
- `src/lib/__tests__/messageRenderingConfig.test.ts` — resolver + migration + coverage tests.
- `src/lib/accentStyle.ts`, `src/lib/kindPresentation.ts` — route through `resolveKind`.
- `src/components/StreamMessage/MessageFrame.tsx` — read resolved style instead of `config.kinds[id]`.
- `src/components/settings-panels/appearance/MessageKindTree.tsx` — Phase B: category list + overrides section + Add-override.
- `src/components/settings-panels/appearance/KindEditor.tsx` — Phase B: drive a category or an override (inherited-field placeholders).
- `src/contexts/MessageRenderingContext.tsx` — version guard already routes pre-v2 → reset; extend to accept v3 and migrate v2→v3 via `mergeConfig`.

---

# Phase A — Config model, resolver, migration, rendering

### Task 1: Define v3 types + the category/override defaults

**Files:**
- Modify: `src/lib/messageRenderingConfig.ts`
- Test: `src/lib/__tests__/messageRenderingConfig.test.ts`

- [ ] **Step 1: Write the failing test** (append to the `messageRenderingConfig` describe)

```ts
import {
  DEFAULT_CATEGORIES, DEFAULT_OVERRIDES, CATEGORIES, type Category,
} from "../messageRenderingConfig";

describe("v3 category catalog", () => {
  it("defines exactly the five categories, each a complete style", () => {
    expect([...CATEGORIES].sort()).toEqual(
      ["agent", "attachment", "bookkeeping", "system", "user"]);
    for (const c of CATEGORIES) {
      const s = DEFAULT_CATEGORIES[c];
      expect(typeof s.presentation).toBe("string");
      expect(typeof s.accentColor).toBe("string");
      expect(typeof s.icon).toBe("string");
      expect(typeof s.borderStyle).toBe("string");
    }
  });

  it("keeps overrides sparse (partial styles, ~a dozen, not 60+)", () => {
    const ids = Object.keys(DEFAULT_OVERRIDES);
    expect(ids).toContain("assistant.text.endTurn");
    expect(ids).toContain("user.systemContext");
    expect(ids).toContain("permission.askUserQuestion");
    expect(ids.length).toBeLessThan(20);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/messageRenderingConfig.test.ts -t "v3 category catalog"`
Expected: FAIL — `DEFAULT_CATEGORIES`/`CATEGORIES`/`DEFAULT_OVERRIDES` not exported.

- [ ] **Step 3: Add the types and defaults** to `messageRenderingConfig.ts` (near the existing `Presentation`/`MessageKindConfig` definitions)

```ts
export const CATEGORIES = ["user", "agent", "system", "attachment", "bookkeeping"] as const;
export type Category = typeof CATEGORIES[number];

// The styling fields shared by categories and overrides — everything that
// drives a card's look. Identity fields (id/label/description/origin) are NOT
// here; categories/overrides are keyed externally.
export interface KindStyle {
  presentation: Presentation;
  accentColor: string;
  icon: IconName;
  headerLabel: string | null;
  borderStyle: BorderStyle;
  alignment: Alignment;
  hiddenInCompact: boolean;
  compactBoundaryLocked?: boolean;
  widget?: string;
  showRawPayload?: boolean;
  iconBordered?: boolean;
  iconBgOpacity?: number;
}

export interface CategoryStyle extends KindStyle {
  label: string;        // shown in settings
  description: string;
}

export const DEFAULT_CATEGORIES: Record<Category, CategoryStyle> = {
  user:        { label: "User", description: "Your prompts, tool results, commands, injected context.", presentation: "card", accentColor: "blue", icon: "User", headerLabel: "You", borderStyle: "solid", alignment: "right", hiddenInCompact: false },
  agent:       { label: "Agent", description: "Claude's text, thinking, tool calls, completions.", presentation: "card", accentColor: "primary", icon: "Bot", headerLabel: "Claude", borderStyle: "solid", alignment: "left", hiddenInCompact: false },
  system:      { label: "System", description: "Notifications, hooks, errors, lifecycle envelopes.", presentation: "card", accentColor: "muted", icon: "Info", headerLabel: null, borderStyle: "solid", alignment: "left", hiddenInCompact: true },
  attachment:  { label: "Attachment", description: "Harness-injected context (reminders, diagnostics, skills).", presentation: "collapsible", accentColor: "muted", icon: "Paperclip", headerLabel: null, borderStyle: "solid", alignment: "left", hiddenInCompact: true, showRawPayload: true },
  bookkeeping: { label: "Bookkeeping", description: "Internal transcript records (hidden by default).", presentation: "side-line", accentColor: "muted", icon: "FileText", headerLabel: null, borderStyle: "dashed", alignment: "left", hiddenInCompact: true },
};

// Sparse — only kinds whose look diverges from their category. Each value is a
// PARTIAL KindStyle (plus optional label for settings display).
export const DEFAULT_OVERRIDES: Record<string, Partial<KindStyle> & { label?: string }> = {
  "assistant.text.endTurn":  { label: "Execution complete", accentColor: "green", icon: "CheckCircle2", compactBoundaryLocked: true },
  "assistant.thinking":      { label: "Thinking", presentation: "collapsible", headerLabel: "Thinking", icon: "Brain", widget: "ThinkingWidget" },
  "assistant.tool-use":      { label: "Tool call", accentColor: "info", icon: "Terminal", headerLabel: null, hiddenInCompact: true },
  "user.systemContext":      { label: "System context", presentation: "collapsible", icon: "Sparkles", accentColor: "purple", showRawPayload: true, alignment: "left", hiddenInCompact: false },
  "user.tool-result":        { label: "Tool result", presentation: "side-line", headerLabel: null, alignment: "left", hiddenInCompact: true },
  "user.command":            { label: "Slash command", presentation: "side-line", icon: "ChevronRight", alignment: "left" },
  "system.notification.error": { label: "Notification (error)", accentColor: "red", icon: "Bell", presentation: "card", hiddenInCompact: false },
  "system.notification.warn":  { label: "Notification (warn)", accentColor: "amber", icon: "Bell", presentation: "card", hiddenInCompact: false },
  "system.notification.stop":  { label: "Notification (stop)", accentColor: "red", icon: "Bell", presentation: "card", hiddenInCompact: false },
  "system.api_error":        { label: "API error", accentColor: "red", icon: "AlertTriangle", presentation: "card", hiddenInCompact: false },
  "system.compact_boundary": { label: "Compacted", icon: "Scissors", presentation: "card", widget: "CompactBoundaryWidget", hiddenInCompact: false },
  "summary.compaction":      { label: "Conversation summary", icon: "FileText", presentation: "card", widget: "SummaryWidget", hiddenInCompact: false, compactBoundaryLocked: true },
  "pr-link":                 { label: "Pull request", presentation: "side-line", icon: "GitPullRequest", accentColor: "info", hiddenInCompact: false },
  "permission.request":      { label: "Permission request", presentation: "card", icon: "ShieldQuestion", accentColor: "amber", hiddenInCompact: false },
  "permission.askUserQuestion": { label: "Question", presentation: "card", icon: "MessageCircleQuestion", accentColor: "primary", hiddenInCompact: false },
};
```

(`IconName`, `Presentation`, `BorderStyle`, `Alignment` already exist in this file. Add any missing icon names — `Paperclip`, `GitPullRequest`, `ShieldQuestion`, `MessageCircleQuestion` — to the `ALLOWED_ICONS` list and `iconMap`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/messageRenderingConfig.test.ts -t "v3 category catalog"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/messageRenderingConfig.ts src/lib/__tests__/messageRenderingConfig.test.ts src/components/settings-panels/appearance/iconMap.tsx
git commit -m "feat(catalog): v3 category + override defaults"
```

---

### Task 2: `originOf(kindId)` — map every kind id to a category

**Files:**
- Modify: `src/lib/messageRenderingConfig.ts`
- Test: `src/lib/__tests__/messageRenderingConfig.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { originOf } from "../messageRenderingConfig";

describe("originOf", () => {
  it("maps dotted prefixes to categories", () => {
    expect(originOf("user.prompt")).toBe("user");
    expect(originOf("assistant.text.endTurn")).toBe("agent");
    expect(originOf("system.notification.error")).toBe("system");
    expect(originOf("attachment.todo_reminder")).toBe("attachment");
  });
  it("maps standalone bookkeeping ids", () => {
    expect(originOf("pr-link")).toBe("bookkeeping");
    expect(originOf("last-prompt")).toBe("bookkeeping");
    expect(originOf("queue-operation")).toBe("bookkeeping");
  });
  it("maps cli envelopes + summary to system, permission to system", () => {
    expect(originOf("cli-stream-init")).toBe("system");
    expect(originOf("cli-stream-result")).toBe("system");
    expect(originOf("permission.request")).toBe("system");
  });
  it("defaults unknown ids to system (never throws)", () => {
    expect(originOf("totally.new.kind")).toBe("system");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/__tests__/messageRenderingConfig.test.ts -t "originOf"`
Expected: FAIL — `originOf` not exported.

- [ ] **Step 3: Implement**

```ts
const BOOKKEEPING_IDS = new Set([
  "pr-link", "mode", "last-prompt", "queue-operation",
  "ai-title", "file-history-snapshot", "permission-mode",
]);

export function originOf(kindId: string): Category {
  if (BOOKKEEPING_IDS.has(kindId)) return "bookkeeping";
  const head = kindId.split(".")[0];
  switch (head) {
    case "user": return "user";
    case "assistant": return "agent";
    case "attachment": return "attachment";
    // system, cli-stream-*, summary, permission, unknown → system bucket
    default: return "system";
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/__tests__/messageRenderingConfig.test.ts -t "originOf"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/messageRenderingConfig.ts src/lib/__tests__/messageRenderingConfig.test.ts
git commit -m "feat(catalog): originOf kind->category mapping"
```

---

### Task 3: `resolveKind(config, kindId)` — the category ⊕ override merge

**Files:**
- Modify: `src/lib/messageRenderingConfig.ts`
- Test: `src/lib/__tests__/messageRenderingConfig.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { resolveKind, createDefaultConfig } from "../messageRenderingConfig";

describe("resolveKind", () => {
  const cfg = createDefaultConfig();
  it("returns the category default when no override exists", () => {
    const s = resolveKind(cfg, "user.prompt");
    expect(s.alignment).toBe("right");
    expect(s.headerLabel).toBe("You");
    expect(s.presentation).toBe("card");
  });
  it("merges an override over its category, per-field", () => {
    const s = resolveKind(cfg, "assistant.text.endTurn");
    expect(s.headerLabel).toBe("Claude");   // inherited from agent
    expect(s.accentColor).toBe("green");     // from override
    expect(s.icon).toBe("CheckCircle2");     // from override
  });
  it("resolves an unseen kind to its category (no unknown)", () => {
    const s = resolveKind(cfg, "attachment.workflow_keyword_request");
    expect(s.presentation).toBe("collapsible"); // attachment default
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/__tests__/messageRenderingConfig.test.ts -t "resolveKind"`
Expected: FAIL — `resolveKind` not exported / `createDefaultConfig` not yet v3.

- [ ] **Step 3: Implement** (and the v3 `createDefaultConfig` it depends on — see Task 4 for the full config; minimal here)

```ts
export function resolveKind(config: MessageRenderingConfig, kindId: string): KindStyle {
  const base = config.categories[originOf(kindId)];
  const patch = config.overrides[kindId];
  return patch ? { ...base, ...patch } : { ...base };
}
```

- [ ] **Step 4: Run to verify it passes** (after Task 4 lands the v3 config)

Run: `npx vitest run src/lib/__tests__/messageRenderingConfig.test.ts -t "resolveKind"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/messageRenderingConfig.ts src/lib/__tests__/messageRenderingConfig.test.ts
git commit -m "feat(catalog): resolveKind category-override merge"
```

---

### Task 4: v3 `MessageRenderingConfig` type + `createDefaultConfig`

**Files:**
- Modify: `src/lib/messageRenderingConfig.ts`
- Test: `src/lib/__tests__/messageRenderingConfig.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("createDefaultConfig (v3)", () => {
  it("is version 3 with categories + sparse overrides", () => {
    const cfg = createDefaultConfig();
    expect(cfg.version).toBe(3);
    expect(Object.keys(cfg.categories).sort())
      .toEqual(["agent", "attachment", "bookkeeping", "system", "user"]);
    expect(cfg.overrides["assistant.text.endTurn"]).toBeDefined();
    expect(cfg.kinds).toBeUndefined(); // flat map is gone
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/__tests__/messageRenderingConfig.test.ts -t "createDefaultConfig"`
Expected: FAIL — config still v2 with `kinds`.

- [ ] **Step 3: Implement** — change the `MessageRenderingConfig` interface and `createDefaultConfig`:

```ts
export interface MessageRenderingConfig {
  version: 3;
  categories: Record<Category, CategoryStyle>;
  overrides: Record<string, Partial<KindStyle> & { label?: string }>;
  hardFilters: HardFilters;
  palette: Palette;
  typography: Typography;
  terminal: TerminalConfig;
  debug: DebugConfig;
}

export function createDefaultConfig(): MessageRenderingConfig {
  return {
    version: 3,
    categories: structuredClone(DEFAULT_CATEGORIES),
    overrides: structuredClone(DEFAULT_OVERRIDES),
    hardFilters: { ...DEFAULT_HARD_FILTERS },
    palette: structuredClone(DEFAULT_PALETTE),
    typography: structuredClone(DEFAULT_TYPOGRAPHY),
    terminal: { ...DEFAULT_TERMINAL },
    debug: { ...DEFAULT_DEBUG },
  };
}
```

Delete `DEFAULT_KINDS`. Anywhere the file referenced `DEFAULT_KINDS` internally, replace with category/override iteration. (Compiler will flag every site.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/__tests__/messageRenderingConfig.test.ts -t "createDefaultConfig"` then `npm run check`
Expected: target test PASS; `npm run check` will now flag downstream `config.kinds`/`DEFAULT_KINDS` consumers — those are Tasks 6–8.

- [ ] **Step 5: Commit**

```bash
git add src/lib/messageRenderingConfig.ts src/lib/__tests__/messageRenderingConfig.test.ts
git commit -m "feat(catalog): v3 config shape (categories+overrides), drop DEFAULT_KINDS"
```

---

### Task 5: `mergeConfig` v2→v3 migration (preserve user customizations as overrides)

**Files:**
- Modify: `src/lib/messageRenderingConfig.ts`
- Test: `src/lib/__tests__/messageRenderingConfig.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("mergeConfig v2->v3 migration", () => {
  it("carries a user-customized v2 kind into a v3 override", () => {
    const v2 = { version: 2, kinds: {
      "user.prompt": { id: "user.prompt", presentation: "side-line", accentColor: "pink" },
    } };
    const cfg = mergeConfig(v2);
    expect(cfg.version).toBe(3);
    expect(cfg.overrides["user.prompt"]).toMatchObject({ presentation: "side-line", accentColor: "pink" });
  });
  it("does not create an override for a v2 kind left at its defaults", () => {
    const v2 = { version: 2, kinds: { "user.prompt": { id: "user.prompt" } } };
    const cfg = mergeConfig(v2);
    expect(cfg.overrides["user.prompt"]).toBeUndefined();
  });
  it("accepts a v3 config unchanged", () => {
    const v3 = createDefaultConfig();
    v3.overrides["pr-link"] = { accentColor: "teal" };
    expect(mergeConfig(v3).overrides["pr-link"]).toMatchObject({ accentColor: "teal" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/__tests__/messageRenderingConfig.test.ts -t "migration"`
Expected: FAIL — `mergeConfig` still produces v2.

- [ ] **Step 3: Implement** — rewrite `mergeConfig`:

```ts
const STYLE_FIELDS: (keyof KindStyle)[] = [
  "presentation","accentColor","icon","headerLabel","borderStyle","alignment",
  "hiddenInCompact","compactBoundaryLocked","widget","showRawPayload","iconBordered","iconBgOpacity",
];

export function mergeConfig(saved: unknown): MessageRenderingConfig {
  const base = createDefaultConfig();
  if (!saved || typeof saved !== "object") return base;
  const s = saved as Record<string, unknown>;

  // v3: merge categories + overrides shallowly over defaults.
  if (s.version === 3) {
    const cats = (s.categories ?? {}) as Record<string, Partial<CategoryStyle>>;
    for (const c of CATEGORIES) base.categories[c] = { ...base.categories[c], ...cats[c] };
    const ov = (s.overrides ?? {}) as Record<string, Partial<KindStyle>>;
    base.overrides = { ...base.overrides, ...ov };
    return mergeShared(base, s); // palette/typography/terminal/debug/hardFilters as today
  }

  // v2 (or pre-v2): convert customized kinds into overrides; reset shared blocks.
  const kinds = (s.kinds ?? {}) as Record<string, Record<string, unknown>>;
  for (const [id, entry] of Object.entries(kinds)) {
    const resolved = resolveKind(base, id) as Record<string, unknown>;
    const diff: Record<string, unknown> = {};
    for (const f of STYLE_FIELDS) {
      if (f in entry && entry[f] !== undefined && entry[f] !== resolved[f]) diff[f] = entry[f];
    }
    if (Object.keys(diff).length > 0) {
      base.overrides[id] = { ...(base.overrides[id] ?? {}), ...diff } as Partial<KindStyle>;
    }
  }
  return mergeShared(base, s);
}
```

(`mergeShared` extracts the existing palette/typography/terminal/debug/hardFilters validation that `mergeConfig` already performs; lift it into that helper so both branches reuse it.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/__tests__/messageRenderingConfig.test.ts -t "migration"`
Expected: PASS.

- [ ] **Step 5: Update the provider version guard.** In `src/contexts/MessageRenderingContext.tsx`, the load path currently resets pre-v2 to defaults and `parseConfig`s v2. Change the guard so `version >= 2` flows through `mergeConfig` (which now migrates v2→v3 and passes v3 through). Reset only `version < 2` / missing.

```ts
// was: if (persistedVersion < 2) reset; else parseConfig(raw)
const v = typeof persistedVersion === "number" ? persistedVersion : 1;
if (!raw || v < 2) { /* reset to fresh defaults, log migration (unchanged) */ }
else { setConfigState(mergeConfig(JSON.parse(raw))); }
```

- [ ] **Step 6: Run to verify provider tests pass**

Run: `npx vitest run src/contexts/__tests__/MessageRenderingContext.test.tsx src/contexts/__tests__/MessageRenderingContext.firstLoad.test.tsx`
Expected: PASS (update fixtures that asserted v2 `kinds` shape to the v3 shape).

- [ ] **Step 7: Commit**

```bash
git add src/lib/messageRenderingConfig.ts src/contexts/MessageRenderingContext.tsx src/lib/__tests__/messageRenderingConfig.test.ts src/contexts/__tests__/
git commit -m "feat(catalog): migrate v2 flat kinds -> v3 overrides"
```

---

### Task 6: Route the resolution helpers through `resolveKind`

**Files:**
- Modify: `src/lib/accentStyle.ts`, `src/lib/kindPresentation.ts`
- Test: `src/lib/__tests__/accentStyle.test.ts`

- [ ] **Step 1: Write the failing test** (accentStyle.test.ts)

```ts
it("resolves accent for a kind via category when it has no override", () => {
  const cfg = createDefaultConfig();
  // attachment.todo_reminder has no override -> attachment category (muted)
  expect(swatchFor(cfg, "attachment.todo_reminder"))
    .toBe(swatchFor(cfg, "attachment.diagnostics"));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/__tests__/accentStyle.test.ts -t "via category"`
Expected: FAIL — helpers still read `config.kinds[id]` (now undefined).

- [ ] **Step 3: Implement** — in `accentStyle.ts` (`accentFor`/`accentStyleFor`/`swatchFor`) and `kindPresentation.ts` (`iconNameFor`/`headerLabelFor`), replace every `config.kinds[kindId]` lookup with `resolveKind(config, kindId)` and read the field off the resolved style. Example for `accentFor`:

```ts
import { resolveKind } from "./messageRenderingConfig";
export function accentFor(config, kindId) {
  const accentColor = resolveKind(config, kindId).accentColor;
  // ...existing hex/palette resolution on accentColor unchanged...
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/__tests__/accentStyle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/accentStyle.ts src/lib/kindPresentation.ts src/lib/__tests__/accentStyle.test.ts
git commit -m "feat(catalog): resolve accent/icon/header via resolveKind"
```

---

### Task 7: Route `MessageFrame` (presentation/borderStyle/showRawPayload/header) through `resolveKind`

**Files:**
- Modify: `src/components/StreamMessage/MessageFrame.tsx`
- Test: `src/components/StreamMessage/__tests__/MessageFrame.test.tsx`

- [ ] **Step 1: Update the test mock** — the existing `MessageFrame.test.tsx` mock returns a v2 `{version:2, kinds:{...}}` config. Replace it with a v3 `{version:3, categories, overrides}` mock (copy `DEFAULT_CATEGORIES`/`DEFAULT_OVERRIDES` shape), keeping the existing assertions (card for `user.prompt`, side-line for a bookkeeping kind, collapsible for `user.systemContext`).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/StreamMessage/__tests__/MessageFrame.test.tsx`
Expected: FAIL — `MessageFrame` reads `config.kinds[streamKind]`.

- [ ] **Step 3: Implement** — in `MessageFrame.tsx` replace:

```ts
const kind = config.kinds[streamKind] ?? config.kinds['unknown'];
```
with:
```ts
import { resolveKind } from '@/lib/messageRenderingConfig';
const kind = resolveKind(config, streamKind);
```
`resolveKind` always returns a style (no null branch), so drop the `if (!kind)` safety net. `kind.presentation` / `kind.borderStyle` / `kind.showRawPayload` / `kind.headerLabel` reads are unchanged. (`kind.id` references become `streamKind`.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/StreamMessage/__tests__/MessageFrame.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/StreamMessage/MessageFrame.tsx src/components/StreamMessage/__tests__/MessageFrame.test.tsx
git commit -m "feat(catalog): MessageFrame resolves style via resolveKind"
```

---

### Task 8: Relax the coverage invariant; fix remaining `DEFAULT_KINDS`/`config.kinds` consumers

**Files:**
- Modify: `src/lib/__tests__/messageRenderingConfig.test.ts` (the "catalog coverage" describe), plus any compiler-flagged consumers (e.g. `appearance/fixtures.ts`, `SamplePreview.tsx`).
- Test: same file.

- [ ] **Step 1: Rewrite the coverage test** — replace "every `classifyStandaloneKind` output has a `DEFAULT_KINDS` entry" with:

```ts
it("every classifier kind id resolves to a category style", () => {
  const cfg = createDefaultConfig();
  for (const id of produced) {           // existing `produced` array of classifier outputs
    const s = resolveKind(cfg, id);
    expect(s.presentation).toBeDefined();
    expect(originOf(id)).toBeDefined();
  }
});
```

- [ ] **Step 2: Run** `npm run check` and fix every compiler error from the removed `DEFAULT_KINDS` / `config.kinds`. Each consumer either iterates `DEFAULT_OVERRIDES`/`CATEGORIES` or calls `resolveKind`. (Settings components are Phase B and may temporarily read a derived flat list — see Task 9.)

Run: `npm run check`
Expected: clean after edits.

- [ ] **Step 3: Run the full unit suite**

Run: `npm test`
Expected: PASS (excluding settings components if Phase B not yet done — keep them compiling via Task 9).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(catalog): relax coverage invariant to category resolution"
```

---

# Phase B — Settings UX (category editors + override list + Add override)

### Task 9: Settings reads the v3 model (keep it compiling/working)

**Files:**
- Modify: `src/components/settings-panels/appearance/MessageKindTree.tsx`, `KindEditor.tsx`, `SamplePreview.tsx`, `fixtures.ts`
- Test: `src/components/settings-panels/__tests__/AppearanceSettings.presentation.test.tsx`

- [ ] **Step 1: Write the failing test** — assert the tree renders the 5 categories and an overrides section:

```ts
it("lists the five categories and an overrides section", async () => {
  // render AppearanceSettings under MessageRenderingProvider (v3 default)
  for (const label of ["User","Agent","System","Attachment","Bookkeeping","Overrides"]) {
    expect(await screen.findByText(label)).toBeInTheDocument();
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/settings-panels/__tests__/AppearanceSettings.presentation.test.tsx -t "five categories"`
Expected: FAIL — tree still iterates `DEFAULT_KINDS`.

- [ ] **Step 3: Implement** — `MessageKindTree` renders: a **Categories** section (5 rows, each opening `KindEditor` bound to `config.categories[c]`, writing back via `setConfig`), then an **Overrides** section listing `Object.entries(config.overrides)` (each row opens `KindEditor` bound to the override, showing "inheriting from {Category}" placeholders for unset fields), then an **Add override** button (Task 11). `KindEditor` gains a `mode: 'category' | 'override'` prop: in override mode, unset fields render the resolved category value as a muted placeholder and only persist a field when the user changes it.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/settings-panels/__tests__/AppearanceSettings.presentation.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings-panels/appearance/ src/components/settings-panels/__tests__/
git commit -m "feat(settings): category editors + overrides list"
```

---

### Task 10: Drop overrides that equal their category on save

**Files:**
- Modify: `src/components/settings-panels/appearance/KindEditor.tsx` (or the setConfig path)
- Test: `src/components/settings-panels/__tests__/AppearanceSettings.presentation.test.tsx`

- [ ] **Step 1: Write the failing test**

```ts
it("removes an override once every field matches its category", () => {
  const cfg = createDefaultConfig();
  cfg.overrides["user.prompt"] = { accentColor: "pink" };
  const cleaned = pruneRedundantOverrides(cfg);     // new pure helper
  cfg.overrides["user.prompt"] = { accentColor: cfg.categories.user.accentColor };
  expect(pruneRedundantOverrides(cfg).overrides["user.prompt"]).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/settings-panels/__tests__/AppearanceSettings.presentation.test.tsx -t "removes an override"`
Expected: FAIL — `pruneRedundantOverrides` undefined.

- [ ] **Step 3: Implement** `pruneRedundantOverrides(config)` in `messageRenderingConfig.ts`: for each override, drop fields equal to the category value; if the override becomes empty, delete it. Call it in the settings `setConfig` path before persisting.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/settings-panels/__tests__/AppearanceSettings.presentation.test.tsx -t "removes an override"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/messageRenderingConfig.ts src/components/settings-panels/appearance/ src/components/settings-panels/__tests__/
git commit -m "feat(settings): prune overrides that match their category"
```

---

### Task 11: "Add override" affordance

**Files:**
- Modify: `src/components/settings-panels/appearance/MessageKindTree.tsx`
- Test: `src/components/settings-panels/__tests__/AppearanceSettings.presentation.test.tsx`

- [ ] **Step 1: Write the failing test**

```ts
it("Add override creates a category-prefilled override editor for the picked kind", async () => {
  // render, click "Add override", pick "assistant.tool-use" from the grouped picker
  // expect config.overrides["assistant.tool-use"] to now exist (empty {} = inherits category)
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/settings-panels/__tests__/AppearanceSettings.presentation.test.tsx -t "Add override"`
Expected: FAIL.

- [ ] **Step 3: Implement** — an "Add override" button opens a picker populated from the set of known classifier kind ids (a `KNOWN_KIND_IDS` array exported from `messageKind.ts`/`messageRenderingConfig.ts`) grouped by `originOf`, plus a free-text field for unseen ids. Selecting one adds `config.overrides[id] = {}` and opens its editor. The editor shows all-inherited (category) values as placeholders; the user diverges fields as desired; `pruneRedundantOverrides` (Task 10) removes it again if they revert everything.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/settings-panels/__tests__/AppearanceSettings.presentation.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings-panels/appearance/ src/components/settings-panels/__tests__/
git commit -m "feat(settings): add-override affordance"
```

---

### Task 12: Full verification gate

- [ ] **Step 1:** `npm run check` — Expected: clean.
- [ ] **Step 2:** `npm test` — Expected: all pass.
- [ ] **Step 3:** `npm run build` — Expected: success.
- [ ] **Step 4:** `npm run rebuild:electron` — Expected: native modules at NMV 145.
- [ ] **Step 5:** Manual: launch the app, open a session, confirm cards render per category, `pr-link` shows as a PR badge (not `unknown`), AskUserQuestion still renders its widget, and Settings → Appearance shows 5 categories + overrides + Add-override.
- [ ] **Step 6: Commit** any fixture/snapshot updates.

```bash
git add -A
git commit -m "test(catalog): verification gate green for v3 categories"
```

---

## Self-Review notes

- **Spec coverage:** model (T1–T4), resolution (T3,T6,T7), migration (T5), gaps-resolve-to-category (T3 unseen-kind test, T8 coverage), prune zero-hit (automatic — not enumerated; T8 confirms they resolve), AskUserQuestion/permission preserved (T1 overrides + T7 widget passthrough; widget rendering already lives in StreamMessage and keys off the kind id, unchanged), Add-override (T11), settings UX (T9–T11). All covered.
- **Type consistency:** `KindStyle`/`CategoryStyle`/`Category`/`resolveKind`/`originOf`/`pruneRedundantOverrides`/`DEFAULT_CATEGORIES`/`DEFAULT_OVERRIDES`/`CATEGORIES` used consistently across tasks.
- **Open risk:** widget kinds (`assistant.thinking`, `compact_boundary`, `summary.compaction`, permission, AskUserQuestion) render via dedicated components in `StreamMessage.tsx` that branch on content/kind id, not on the catalog `widget` field — so Phase A does not change their behavior; the `widget` field stays informational (as it is today). Verify in T12 step 5 that none regressed.
