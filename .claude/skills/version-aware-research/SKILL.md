---
name: version-aware-research
description: Use when syntax, configuration, CLI flags, APIs, or library behavior may have changed since training — Claude Code settings/hooks/skills/MCP, Electron, Vite, React 19, better-sqlite3, node-pty, Electron Forge — and the exact current form matters.
---

# Version-Aware Research

Training data is stale for anything that moves monthly. Confirm before relying on memory.

## When

- Claude Code: settings keys, hook events, skill frontmatter, permission rule
  syntax, stream-json record shapes, MCP server config. Prefer the official
  docs at code.claude.com over Context7 for these.
- Electron / Electron Forge / Vite / React 19 / Tailwind / better-sqlite3 /
  node-pty / vitest: config schema, CLI flags, migration behaviour.
- Any time two plausible spellings exist (`allowed-tools` vs `allowed_tools`)
  and the wrong one is silently ignored.

## How

1. Check what the repo already does (`rg` for the API or key).
2. If still uncertain or version-sensitive, look it up: Context7
   (`resolve-library-id` → `query-docs`) for libraries; WebFetch of the official
   page for Claude Code.
3. Ask one narrow question — the flag, the schema, the signature — not "read
   the docs".
4. Implement immediately; summarise only the decision-relevant line.

## Don't

- Don't fetch docs for a library whose usage is already clear in the repo.
- Don't research the stack "generally".
- Don't stop at notes; the point is the code change.
