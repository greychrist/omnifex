---
name: version-aware-research
description: Use when syntax, configuration, APIs, or library behavior may be version-sensitive. Guides Codex to use Context7 selectively so research stays current without wasting tokens.
---

# Version-Aware Research

Use this skill when working with libraries, frameworks, or tools whose behavior may have changed since training data.

## When To Use

- React, Vite, Tauri, Tailwind, Axum, rusqlite, MCP, Codex settings/plugins
- Build config, CLI flags, plugin manifests, or JSON schema details
- Any time the exact syntax or current recommendation matters

## Research Strategy

1. Check repo-local patterns first.
2. If the answer is version-sensitive or uncertain, use Context7.
3. Pull only the specific docs needed for the decision.
4. Return to the code and implement immediately.

## Context7 Discipline

- Use Context7 for targeted lookup, not broad reading.
- Ask focused questions like:
  - exact CLI flag usage
  - current config schema
  - current recommended API call
  - version-specific migration behavior
- Do not fetch docs for libraries whose usage is already clear from the repo.

## Good Examples

- "What is the current Codex plugin manifest shape?"
- "What does the latest Tauri 2 command signature expect here?"
- "What is the right TypeScript language server command/config now?"

## Bad Examples

- "Read all React docs"
- "Read all Tauri docs"
- "Research this stack generally"

## Output Style

- Summarize only the decision-relevant part.
- Prefer a short conclusion over long copied excerpts.
- After research, make the code change instead of stopping at notes.
