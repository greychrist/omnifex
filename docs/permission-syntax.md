# Claude Code Permissions Syntax Reference

Rules live under `permissions` in `settings.json` / `settings.local.json`:

```json
{
  "permissions": {
    "allow": [],
    "ask": [],
    "deny": []
  }
}
```

Evaluation order: **deny → ask → allow**. First match wins. Deny always takes precedence.

Rule format: `Tool` (matches all uses) or `Tool(specifier)` (fine-grained).

## Bash

Wildcards use `*` anywhere in the pattern. `:*` is shorthand for trailing `*`.

```
Bash(npm run build)      → exact command
Bash(npm run test *)     → prefix + space = word boundary
Bash(npm *)              → any command starting with npm
Bash(npm:*)              → equivalent to "npm *"
Bash(* install)          → any command ending with install
Bash(git * main)         → git checkout main, git merge main, etc.
Bash                     → all bash commands
```

- Space before `*` enforces word boundary: `Bash(ls *)` matches `ls -la` but NOT `lsof`. `Bash(ls*)` matches both.
- Shell operators are respected: `Bash(safe-cmd *)` does NOT cover `safe-cmd && other-cmd`. Each subcommand needs its own rule.
- Argument-constraining rules are fragile (option reordering, redirects, variable expansion break them). For URL filtering, deny `curl`/`wget` and use `WebFetch(domain:...)`.

## Read / Edit

**Only `Edit(path)` and `Read(path)` rules participate in file permission
checks** (CLI ≥2.1.210). `Write(path)`, `NotebookEdit(path)`, and `Glob(path)`
rules are accepted but never matched — the CLI emits a startup warning for
each one, in every list (allow/ask/deny). Use `Edit(docs/**)` instead of
`Write(docs/**)`/`NotebookEdit(docs/**)`, and `Read(docs/**)` instead of
`Glob(docs/**)`. Bare tool-name rules without a path (e.g. deny `Write`) are
unaffected — they match the tool everywhere.

A `Read(path)` **deny** rule also blocks the Edit tool on the same path,
including creating new files there (CLI ≥2.1.208). Write/NotebookEdit aren't
covered by that — add an `Edit` deny rule for paths no tool may change.

Gitignore-style patterns with four path prefix types:

| Prefix | Meaning | Example |
|---|---|---|
| `//path` | **Absolute** from filesystem root | `Read(//Users/you/secrets/**)` |
| `~/path` | Home directory | `Read(~/.zshrc)` |
| `/path` | Relative to **project root** | `Edit(/src/**/*.ts)` |
| `path` or `./path` | Relative to **cwd** | `Read(*.env)` |

**CRITICAL:** `/Users/...` is NOT absolute — it's relative to project root. Use `//Users/...` for true absolute paths.

Glob: `*` matches within a single directory, `**` matches recursively.

```
Read(//Users/greg/Repos/personal/reference/WIN/**)
Edit(//Users/greg/Repos/personal/WIN/.claude/**)
Edit(~/scratch/*.md)
Edit                      → all edits, no restriction
```

Depth semantics (tightened in CLI 2.1.214):

- Bare filenames match at any depth under the anchor: `Read(.env)` ≡
  `Read(**/.env)`.
- A single-segment directory pattern anchors at the rule's source dir only:
  allow `Edit(src/**)` matches `<cwd>/src/` — NOT nested `src/` dirs anywhere
  in the tree (pre-2.1.214 allow rules wrongly matched any depth). Write
  `Edit(**/src/**)` for any-depth. Hook `if:` conditions changed the same way;
  deny/ask rules keep their any-depth match.
- The anchor for `/path` rules is the settings source (project root for
  project settings, `~/.claude/` for user settings, original cwd for
  settings.local.json / CLI flags / session rules).

Read/Edit deny rules apply only to Claude's built-in file tools, NOT to Bash subprocesses. `Read(./.env)` in deny blocks the Read tool but does not stop `cat .env`. For OS-level enforcement, use sandboxing.

## WebFetch

```
WebFetch(domain:example.com)
WebFetch                  → all fetches
```

## MCP

Double-underscore format, no parentheses:

```
mcp__puppeteer                        → entire server
mcp__puppeteer__*                     → same, wildcard form
mcp__puppeteer__puppeteer_navigate    → specific tool
```

## Agent (subagents)

```
Agent(Explore)
Agent(Plan)
Agent(my-custom-agent)
```

Typically used in `deny` to disable specific subagents.

## Not valid rule types

- `Skill(...)` — skills aren't permission-gated at the skill level; the tools they invoke are what get checked.
- Slash commands — not permission-gated directly; pre-approve the underlying tools.

## Settings precedence (highest first)

1. Managed settings (can't be overridden)
2. CLI args
3. `.claude/settings.local.json`
4. `.claude/settings.json`
5. `~/.claude/settings.json`

Denies cascade down (any level can block). Allows merge across levels.

## Gotchas

- Invalid rules (bad tool names, typos) are silently filtered at load time. The rest of the file still loads. Check `/permissions` to see what actually got parsed.
- For cross-project file access, prefer `additionalDirectories` over scattered `Read(//...)` rules. It grants read + edit-per-mode to extra paths.
- Windows paths normalize to POSIX before matching: `C:\Users\x` → `/c/Users/x`. Use `//c/**/.env`.
- `bypassPermissions` mode still prompts for writes to `.git`, `.claude`, `.vscode`, `.idea`, `.husky` — but exempts `.claude/commands`, `.claude/agents`, `.claude/skills`.

Source: https://code.claude.com/docs/en/permissions
