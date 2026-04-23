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

## Read / Edit / Write

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
Write(~/scratch/*.md)
Edit                      → all edits, no restriction
```

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
