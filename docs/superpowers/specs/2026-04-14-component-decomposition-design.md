# Component Monolith Decomposition Design

**Date**: 2026-04-14

---

## Problem

Four renderer components exceed 1000 lines each, mixing multiple responsibilities in single files:

| Component | Lines | Core Problem |
|-----------|-------|-------------|
| ToolWidgets | 3046 | Every tool type rendered inline in one switch |
| ClaudeCodeSession | 2257 | Streaming + UI + timeline + permissions + prompts |
| FloatingPromptInput | 1424 | Input + model picker + controls + slash commands + images |
| Settings | 1080 | 6 tab panels in one switch |

## Approach

Extract by responsibility. Each decomposition keeps the public interface identical — parent components don't change. Pure refactor, no behavioral changes.

---

## 1. ClaudeCodeSession (2257 → ~700 lines)

### Extract 5 hooks + 2 utilities:

| File | Lines | Responsibility |
|------|-------|---------------|
| `src/hooks/useSessionLifecycle.ts` | ~300 | startPersistentSession, event listeners, stop, persistentSessionRef |
| `src/hooks/useStreamMessages.ts` | ~350 | handleStreamMessage, message state, metrics, cost, context usage |
| `src/hooks/useSessionTimeouts.ts` | ~80 | Response/inactivity timeouts, health checks, elapsed time |
| `src/hooks/usePermissions.ts` | ~100 | Permission state, pending tool use, auto-allow, response handlers |
| `src/hooks/useSendPrompt.ts` | ~120 | handleSendPrompt, prompt queue, queue processing |
| `src/lib/sessionExporters.ts` | ~80 | exportAsJsonl, exportAsMarkdown — pure functions |
| `src/lib/messageFilters.ts` | ~60 | displayableMessages filtering predicate — pure function |

ClaudeCodeSession.tsx retains: props, pre-session config state, account/git resolution, UI panel state, auto-scroll, JSX layout.

## 2. ToolWidgets (3046 → ~50 line dispatcher)

### Extract per-tool components:

```
src/components/tools/
  index.ts              — registry: toolName → component
  BashWidget.tsx
  ReadWidget.tsx
  WriteWidget.tsx
  EditWidget.tsx
  GlobWidget.tsx
  GrepWidget.tsx
  WebSearchWidget.tsx
  WebFetchWidget.tsx
  NotebookEditWidget.tsx
  LSPWidget.tsx
  GenericToolWidget.tsx  — fallback for unknown tools
  ... (one per tool type found in current code)
```

ToolWidgets.tsx becomes a thin dispatcher that looks up and renders the matching component.

## 3. FloatingPromptInput (1424 → ~400 lines)

### Extract 3 sub-components + 1 hook:

| File | Lines | Responsibility |
|------|-------|---------------|
| `src/components/ModelPicker.tsx` | ~150 | Model selection dropdown, live switching |
| `src/components/ControlBar.tsx` | ~150 | Effort, thinking, permission mode controls |
| `src/components/ImageAttachments.tsx` | ~100 | Image paste/drop, preview |
| `src/hooks/useSlashCommandAutocomplete.ts` | ~100 | Slash command detection, filtering, picker state |

## 4. Settings (1080 → ~100 line shell)

### Extract per-tab components:

```
src/components/settings/
  index.tsx               — tab shell + navigation
  GeneralSettings.tsx
  PermissionsSettings.tsx
  LogSettings.tsx
  MCPSettings.tsx
  HooksSettings.tsx
```

AccountSettings.tsx already exists as a separate component — just wire it in.

## Testing

All four are pure refactors. Verification after each: `npm run check && npm run build`. No new tests needed — the public interfaces are unchanged.

## Execution Order

1. ClaudeCodeSession (highest value, most complex)
2. ToolWidgets (second largest, straightforward per-tool extraction)
3. Settings (simplest — tab panel extraction)
4. FloatingPromptInput (depends on ClaudeCodeSession hooks being done)
